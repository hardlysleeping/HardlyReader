<?php
declare(strict_types=1);

/**
 * Checks for the pairing routes and their store: the server half of
 * "sign in on a phone by pairing it with a device that can show the captcha".
 *
 *   docker cp <ext> hr:/tmp/hrpair && docker exec hr php /tmp/hrpair/tests/pairing.php
 *
 * Plain PHP, like the other tests here: no phpunit on the host or in the
 * FreshRSS container, and the router is deliberately pure, so booting it is a
 * require and a handful of closures. What is checked is the contract the client
 * depends on:
 *
 * - a code is eight digits, five minutes long, and worth nothing until a
 *   signed-in person approves it;
 * - the approve press is the only place an account is attached, and a second
 *   account cannot take a code that is already bound;
 * - a code signs one device in once — a second redeem is `used`, not a second
 *   token;
 * - the token is written as a hash and never in the clear, and revoking it stops
 *   the very next request;
 * - `request` and `redeem` are reachable while signed out, and nothing else
 *   becomes reachable with them.
 *
 * The clock and the token mint are injected, so a five-minute ticket and a
 * ninety-day credential are walked through their whole lives in microseconds.
 */

// DATA_PATH is only needed by rootForServer(); the store itself takes a root.
if (!defined('DATA_PATH')) {
	define('DATA_PATH', sys_get_temp_dir() . '/hrpair-data-' . bin2hex(random_bytes(4)));
}

require_once __DIR__ . '/../lib/HardlyReadApiResponse.php';
require_once __DIR__ . '/../lib/HardlyReadPairingStore.php';
require_once __DIR__ . '/../lib/HardlyReadApi.php';

$checks = 0;
$failures = 0;

function check(string $label, bool $ok, string $detail = ''): void
{
	global $checks, $failures;
	$checks++;
	if ($ok) {
		echo "PASS  {$label}\n";
	} else {
		$failures++;
		echo "FAIL  {$label}" . ($detail === '' ? '' : "  ({$detail})") . "\n";
	}
}

/** A clock a test can move, and a mint that hands out a different token each time. */
final class PairingClock
{
	public int $now = 1_760_000_000;
}

$clock = new PairingClock();
$minted = 0;
$mint = function () use (&$minted): string {
	$minted++;

	return HardlyReadPairingStore::TOKEN_PREFIX . str_pad(dechex($minted), 8, '0', STR_PAD_LEFT) . str_repeat('0', 56);
};

$root = sys_get_temp_dir() . '/hrpair-' . bin2hex(random_bytes(4));
mkdir($root, 0770, true);
$store = new HardlyReadPairingStore($root, fn (): int => $clock->now, $mint);

// ------------------------------------------------------------------ the code

$ticket = $store->issue('Phone');
check('a new ticket is eight digits in two groups', preg_match('/^[0-9]{4} [0-9]{4}$/', $ticket['code']) === 1, $ticket['code']);
check('…and belongs to nobody yet', $ticket['account'] === null && $ticket['approvedAt'] === null);
check('…and lasts five minutes', $ticket['expiresAt'] === $clock->now + 300, (string) $ticket['expiresAt']);
check('…and keeps the label the device gave', $ticket['label'] === 'Phone');

$drawn = [];
for ($i = 0; $i < 100; $i++) {
	$drawn[] = $store->issue('Phone')['code'];
}
check('a hundred codes in a row are a hundred different codes', count(array_unique($drawn)) === 100, (string) count(array_unique($drawn)));
check(
	'no code is the file it is stored in',
	glob($root . '/tickets/*.json') !== []
		&& glob($root . '/tickets/*' . str_replace(' ', '', $drawn[0]) . '*') === [],
);

check('a code with its space or a dash is the same code', HardlyReadPairingStore::normalizeCode('4271 8093') === '42718093'
	&& HardlyReadPairingStore::normalizeCode('4271-8093') === '42718093');
check('seven digits, nine digits and letters are not codes', HardlyReadPairingStore::normalizeCode('4271809') === null
	&& HardlyReadPairingStore::normalizeCode('427180933') === null
	&& HardlyReadPairingStore::normalizeCode('4271809a') === null);
check('nothing at all is not a code', HardlyReadPairingStore::normalizeCode(null) === null
	&& HardlyReadPairingStore::normalizeCode(42) === null);

// --------------------------------------------------------------- the waiting

// One second later, because the hundred above share a timestamp: the panel
// shows the newest few, and a test that issued a hundred codes in the same
// instant would be asking which of them is "newest" rather than whether the
// code it just took is in the list.
$clock->now += 1;
$offer = $store->issue('Phone');
$waiting = $store->pending();
check('a code nobody has approved is waiting to be approved', in_array($offer['code'], array_column($waiting, 'code'), true));
check('…and brings its label with it, so a person knows what is asking', ($waiting[0]['label'] ?? '') === 'Phone');
check(
	'the store counts in seconds, and keeps the ticket\'s own deadline',
	($waiting[0]['expiresAt'] ?? 0) === $clock->now + HardlyReadPairingStore::CODE_TTL_SECONDS,
	(string) ($waiting[0]['expiresAt'] ?? 0),
);

$clock->now += 301;
check('an expired code is not waiting any more', !in_array($offer['code'], array_column($store->pending(), 'code'), true));
$clock->now -= 301;

// ------------------------------------------------------------- the approval

$approved = $store->approve($offer['code'], 'alice');
check('a person on a signed-in device approves the code', ($approved['ok'] ?? false) === true);
check('…and the ticket is now that account\'s', ($approved['pairing']['account'] ?? '') === 'alice');
check('…stamped with when', ($approved['pairing']['approvedAt'] ?? 0) === $clock->now);
check(
	'the same account pressing approve twice is not an error',
	($store->approve($offer['code'], 'alice')['ok'] ?? false) === true,
);
$stolen = $store->approve($offer['code'], 'bob');
check('another account cannot take a code that is already bound', ($stolen['reason'] ?? '') === 'wrong_account');
check('an approved code is no longer offered for approval', !in_array($offer['code'], array_column($store->pending(), 'code'), true));

$late = $store->issue('Tablet');
$clock->now += 300;
check('an expired code cannot be approved', ($store->approve($late['code'], 'alice')['reason'] ?? '') === 'expired');
$clock->now -= 300;

// ---------------------------------------------------------------- the redeem

$early = $store->issue('Phone');
check('a code nobody approved cannot be redeemed', ($store->redeem($early['code'], null, 'Phone')['reason'] ?? '') === 'not_approved');
check('…and that is a refusal a phone keeps asking through, not an error', ($store->redeem($early['code'], null, 'Phone')['ok'] ?? true) === false);

$wrong = $store->redeem('00000000', null, 'Phone');
check('a code that is not there is a wrong code', ($wrong['reason'] ?? '') === 'wrong_code');
check('a code that cannot be typed is invalid', ($store->redeem('1234', null, 'Phone')['reason'] ?? '') === 'invalid_code');
check('a code of another account is refused to a device that names its own', ($store->redeem($offer['code'], 'bob', 'Phone')['reason'] ?? '') === 'wrong_account');

$redeem = $store->redeem($offer['code'], null, 'Phone');
check('an approved code redeems', ($redeem['ok'] ?? false) === true);
check('…for a device token', preg_match('/^hrd_[0-9a-f]{64}$/', (string) ($redeem['token'] ?? '')) === 1, (string) ($redeem['token'] ?? ''));
check('…that acts as the account that approved it', ($redeem['account'] ?? '') === 'alice');
check('…and the label the device gave is kept with it', ($redeem['label'] ?? '') === 'Phone');
check('…with a ninety-day deadline', ($redeem['expiresAt'] ?? 0) === $clock->now + HardlyReadPairingStore::CREDENTIAL_TTL_SECONDS);

$again = $store->redeem($offer['code'], null, 'Phone');
check('a second claim is refused: a code signs one device in once', ($again['reason'] ?? '') === 'used');
check('…and mints nothing', !isset($again['token']));

$revokedTicket = $store->issue('Phone');
$store->approve($revokedTicket['code'], 'alice');
// No route revokes a ticket yet — the store is the place that would, and the
// app's own module has the transition. Written here directly so the refusal is
// still asserted rather than assumed.
file_put_contents(
	$root . '/tickets/' . hash('sha256', str_replace(' ', '', $revokedTicket['code'])) . '.json',
	json_encode(array_merge($revokedTicket, ['account' => 'alice', 'approvedAt' => $clock->now, 'revokedAt' => $clock->now])),
);
check('a withdrawn code cannot be redeemed', ($store->redeem($revokedTicket['code'], null, 'Phone')['reason'] ?? '') === 'revoked');

// ------------------------------------------------------------ the credential

check('the token signs its device in', $store->authenticate('alice', $redeem['token']) === true);
check('…and only as its own account', $store->authenticate('bob', $redeem['token']) === false);
check('a token that is not one is refused without reading anything', $store->authenticate('alice', 'not-a-token') === false);

$written = (string) file_get_contents($root . '/devices.json');
check('the device file holds a hash, not the token', !str_contains($written, $redeem['token']));
check('…and the hash is a sha256 of it', str_contains($written, hash('sha256', $redeem['token'])));
check('…with the label and the account beside it', str_contains($written, '"alice"') && str_contains($written, '"Phone"'));
check('the account can list its devices without their secrets', count($store->devicesFor('alice')) === 1
	&& !isset($store->devicesFor('alice')[0]['token']));

$expiry = (int) json_decode($written, true)['devices'][0]['expiresAt'];
$clock->now += 3600;
$store->authenticate('alice', $redeem['token']);
$after = (int) json_decode((string) file_get_contents($root . '/devices.json'), true)['devices'][0]['expiresAt'];
check('using it slides the deadline instead of wearing it down', $after === $clock->now + HardlyReadPairingStore::CREDENTIAL_TTL_SECONDS, (string) $after);
check('…and the old deadline is behind it', $expiry < $after);

// --------------------------------------------------------------- the revoke

check('a device can withdraw its own credential', ($store->revoke('alice', $redeem['token'])['ok'] ?? false) === true);
check('…and the next request is refused', $store->authenticate('alice', $redeem['token']) === false);
check('withdrawing twice is not an error', ($store->revoke('alice', $redeem['token'])['ok'] ?? false) === true);
check('one account cannot withdraw another\'s credential', ($store->revoke('bob', $redeem['token'])['reason'] ?? '') === 'unauthorized');
check('a revoked credential is gone from the device list', $store->devicesFor('alice') === []);

$other = $store->issue('Tablet');
$store->approve($other['code'], 'alice');
$second = $store->redeem($other['code'], null, 'Tablet');
$clock->now += HardlyReadPairingStore::CREDENTIAL_TTL_SECONDS;
check('a credential nobody used for ninety days is refused', $store->authenticate('alice', (string) $second['token']) === false);
$clock->now -= HardlyReadPairingStore::CREDENTIAL_TTL_SECONDS;

// ------------------------------------------------------------------ the routes

/**
 * A router wired the way extension.php wires it: one credential that answers
 * 'good' as alice, and a device token accepted through the same collaborator.
 */
function pairingApi(?HardlyReadPairingStore $store): HardlyReadApi
{
	return new HardlyReadApi(
		authenticate: function (string $authorization) use ($store): ?string {
			if ($authorization === 'good') {
				return 'alice';
			}
			if ($store !== null && preg_match('/^GoogleLogin auth=([^\/]+)\/(.+)$/', $authorization, $matches) === 1) {
				return $store->authenticate($matches[1], $matches[2]) ? $matches[1] : null;
			}

			return null;
		},
		loadHiddenCategories: fn (string $u): ?object => null,
		loadFavorites: fn (string $u): ?object => null,
		loadSidebarIndent: fn (string $u): ?object => null,
		loadPairing: $store === null ? null : fn (): ?object => $store,
	);
}

$api = pairingApi($store);

$asked = $api->dispatch('POST', 'v1/pair/request', '', ['label' => 'Phone']);
check('a signed-out phone can ask for a code', $asked->status === 200 && preg_match('/^[0-9]{4} [0-9]{4}$/', (string) $asked->body['code']) === 1);
check('…and the answer is milliseconds', $asked->body['expiresAt'] > 1_000_000_000_000);
check(
	'the answer says nothing about who will approve it',
	!isset($asked->body['account']) && !isset($asked->body['token']),
);

$closed = $api->dispatch('GET', 'v1/pair/pending', '');
check('a signed-out caller still cannot list what is waiting', $closed->status === 401);
$hidden = $api->dispatch('GET', 'v1/pair/nonsense', '');
check('…nor probe for pairing routes that do not exist', $hidden->status === 401);

$pending = $api->dispatch('GET', 'v1/pair/pending', 'good');
check('a signed-in device sees the code that is waiting', $pending->status === 200
	&& in_array($asked->body['code'], array_column($pending->body['pairings'], 'code'), true));

$approvedRoute = $api->dispatch('POST', 'v1/pair/approve', 'good', ['code' => $asked->body['code']]);
check('…and approves it', $approvedRoute->status === 200 && ($approvedRoute->body['approved'] ?? false) === true);
check('…for its own account', ($approvedRoute->body['account'] ?? '') === 'alice');

$redeemed = $api->dispatch('POST', 'v1/pair/redeem', '', ['code' => $asked->body['code'], 'label' => 'Phone']);
check('the phone redeems it while still signed out', $redeemed->status === 200);
check('…and gets a token and the account it acts as', preg_match('/^hrd_[0-9a-f]{64}$/', (string) ($redeemed->body['token'] ?? '')) === 1
	&& ($redeemed->body['account'] ?? '') === 'alice');
check('a second redeem is refused as used', $api->dispatch('POST', 'v1/pair/redeem', '', ['code' => $asked->body['code']])->status === 409);

$awaiting = $api->dispatch('POST', 'v1/pair/request', '', ['label' => 'Tablet']);
$notYet = $api->dispatch('POST', 'v1/pair/redeem', '', ['code' => $awaiting->body['code']]);
check('a code nobody approved is 409 not_approved, which a phone waits through', $notYet->status === 409
	&& ($notYet->body['error']['code'] ?? '') === 'not_approved');

$missing = $api->dispatch('POST', 'v1/pair/redeem', '', ['code' => '0000 0000']);
check('a code that is not waiting is 404 wrong_code', $missing->status === 404
	&& ($missing->body['error']['code'] ?? '') === 'wrong_code');

$malformed = $api->dispatch('POST', 'v1/pair/redeem', '', ['code' => '12']);
check('a code that cannot be typed is 400 invalid_code', $malformed->status === 400
	&& ($malformed->body['error']['code'] ?? '') === 'invalid_code');

$wrongMethod = $api->dispatch('GET', 'v1/pair/request', '');
check('the request route says which method it takes', $wrongMethod->status === 405 && $wrongMethod->headers['Allow'] === 'POST');

$token = (string) $redeemed->body['token'];
$revoked = $api->dispatch('POST', 'v1/pair/revoke', 'GoogleLogin auth=alice/' . $token);
check('a paired device signs in with its own token', $revoked->status === 200 && ($revoked->body['revoked'] ?? false) === true);
check('…and that token no longer authenticates', $store->authenticate('alice', $token) === false);
check(
	'…so the next request is 401, the same as a wrong password',
	$api->dispatch('GET', 'v1/pair/pending', 'GoogleLogin auth=alice/' . $token)->status === 401,
);
check(
	'another account cannot revoke it',
	$api->dispatch('POST', 'v1/pair/revoke', 'good')->status === 401,
);

$bare = pairingApi(null);
check('an install whose router predates pairing says so instead of 404', $bare->dispatch('POST', 'v1/pair/request', '', ['label' => 'Phone'])->status === 503
	&& ($bare->dispatch('POST', 'v1/pair/request', '', ['label' => 'Phone'])->body['error']['code'] ?? '') === 'pairing_unavailable');

// -------------------------------------------------- and nothing else opened

$rootPath = HardlyReadPairingStore::rootForServer();
check(
	'the server store lives under DATA_PATH, not in a user config a refresh could rewrite',
	str_starts_with($rootPath, DATA_PATH) && str_contains($rootPath, 'extensions'),
	$rootPath,
);
check('…and its tokens are recognisable by their prefix', HardlyReadPairingStore::TOKEN_PREFIX === 'hrd_');

$noAuth = $api->dispatch('GET', 'v1/state', '');
check('a signed-out caller still cannot read the state', $noAuth->status === 401);
$noAuthWrite = $api->dispatch('PUT', 'v1/indent', '', ['px' => 20]);
check('…nor write anything', $noAuthWrite->status === 401);
$unknown = $api->dispatch('GET', 'v1/nope', '');
check('the route table has not become enumerable', $unknown->status === 401);

echo "\n{$checks} checks, {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
