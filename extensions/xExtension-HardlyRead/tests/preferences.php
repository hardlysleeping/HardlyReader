<?php
declare(strict_types=1);

/**
 * Checks for the remembered-settings routes and their store.
 *
 *   docker cp <ext> hr:/tmp/hrprefs && docker exec hr php /tmp/hrprefs/tests/preferences.php
 *
 * Plain PHP, like the other tests here: there is no phpunit on the host or in
 * the FreshRSS container. What is checked is the contract the client depends
 * on — auth first, one document per account, last write wins by stamp, a stale
 * write answered with the winning document, and unknown namespaces surviving a
 * round trip so an older server cannot prune a newer client's settings.
 */

// DATA_PATH is only needed by dirForUser(); the store itself takes a directory.
if (!defined('DATA_PATH')) {
	define('DATA_PATH', sys_get_temp_dir() . '/hrprefs-data');
}

require_once __DIR__ . '/../lib/HardlyReadApiResponse.php';
require_once __DIR__ . '/../lib/HardlyReadPreferenceStore.php';
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

$dir = sys_get_temp_dir() . '/hrprefs-' . bin2hex(random_bytes(4));
mkdir($dir, 0770, true);

// ---------------------------------------------------------------- the store

$store = new HardlyReadPreferenceStore($dir);
$empty = $store->load();
check('an unwritten store reads as empty', $empty['entries'] === [] && $empty['updatedAt'] === 0);

$document = [
	'apiVersion' => 1,
	'updatedAt' => 1761000000000,
	'entries' => [
		'reading' => ['updatedAt' => 1761000000000, 'value' => ['textScale' => 1.2, 'listView' => 'cards']],
		'theme' => ['updatedAt' => 1760999999000, 'value' => ['mode' => 'dark', 'accent' => '#613583']],
		// A namespace this build has never heard of: it must survive untouched.
		'experiments' => ['updatedAt' => 1760999998000, 'value' => ['future' => true]],
	],
];
check('a save reports success', $store->save($document) === true);

$back = $store->load();
check('the document round trips', ($back['entries']['reading']['value']['listView'] ?? '') === 'cards', json_encode($back));
check('an unknown namespace survives', ($back['entries']['experiments']['value']['future'] ?? null) === true);
check('the newest stamp becomes the document stamp', $back['updatedAt'] === 1761000000000, (string) $back['updatedAt']);

$poison = [
	'updatedAt' => 5,
	'entries' => [
		'reading' => ['updatedAt' => 5, 'value' => ['__proto__' => ['polluted' => true], 'textScale' => 1.1]],
		'bad name!' => ['updatedAt' => 5, 'value' => ['a' => 1]],
		'theme' => ['updatedAt' => 0, 'value' => ['mode' => 'light']],
		'cards' => ['updatedAt' => 5, 'value' => 'not an object'],
	],
];
$store->save($poison);
$clean = $store->load();
check('a poison key is dropped', !array_key_exists('__proto__', $clean['entries']['reading']['value'] ?? []), json_encode($clean['entries']['reading'] ?? []));
check('the fields beside it survive', ($clean['entries']['reading']['value']['textScale'] ?? 0) === 1.1);
check('a namespace name that is not one is refused', !isset($clean['entries']['bad name!']));
check('a zero stamp stores nothing', !isset($clean['entries']['theme']));
check('a value that is not a JSON object is refused', !isset($clean['entries']['cards']));

$claimed = HardlyReadPreferenceStore::sanitise([
	'updatedAt' => 9000000000000,
	'entries' => ['reading' => ['updatedAt' => 10, 'value' => ['a' => 1]]],
]);
check('a document cannot claim a stamp its entries do not carry', $claimed['updatedAt'] === 10, (string) $claimed['updatedAt']);

file_put_contents($store->file(), '{not json');
check('a corrupt file reads as empty instead of throwing', $store->load()['entries'] === []);

$refused = false;
try {
	HardlyReadPreferenceStore::dirForUser('../../etc');
} catch (InvalidArgumentException $e) {
	$refused = true;
}
check('a login that is not a username cannot name a directory', $refused);
check(
	'an ordinary login lands under that user',
	str_contains(HardlyReadPreferenceStore::dirForUser('alice'), '/users/alice/extensions/HardlyRead'),
);

// ---------------------------------------------------------------- the router

function api(?HardlyReadPreferenceStore $store, array &$calls = []): HardlyReadApi
{
	return new HardlyReadApi(
		authenticate: function (string $auth): ?string {
			return $auth === 'good' ? 'alice' : null;
		},
		loadHiddenCategories: fn (string $u): ?object => null,
		loadFavorites: fn (string $u): ?object => null,
		loadSidebarIndent: fn (string $u): ?object => null,
		loadPreferences: $store === null ? null : function (string $u) use ($store, &$calls): array {
			$calls[] = "load:{$u}";
			return $store->load();
		},
		savePreferences: $store === null ? null : function (string $u, array $doc) use ($store, &$calls): bool {
			$calls[] = "save:{$u}";
			return $store->save($doc);
		},
	);
}

$fresh = new HardlyReadPreferenceStore($dir . '/router');
$calls = [];
$response = api($fresh, $calls)->dispatch('GET', 'v1/preferences', '');
check('an unauthenticated read is refused before anything is stored', $response->status === 401 && $calls === []);

$response = api($fresh, $calls)->dispatch('GET', 'v1/preferences', 'good');
check('an empty document is a 200, not a 404', $response->status === 200);
check('and its entries are an object on the wire', $response->body['entries'] instanceof stdClass);

$write = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'apiVersion' => 1,
	'updatedAt' => 2000,
	'entries' => [
		'reading' => ['updatedAt' => 2000, 'value' => ['textScale' => 1.3]],
		'theme' => ['updatedAt' => 1900, 'value' => ['mode' => 'light']],
	],
]);
check('a write is accepted', $write->status === 200 && ($write->body['entries']['reading']['value']['textScale'] ?? 0) === 1.3);

$read = api($fresh, $calls)->dispatch('GET', 'v1/preferences', 'good');
check('and the next read on another device sees it', ($read->body['entries']['reading']['value']['textScale'] ?? 0) === 1.3);

$stale = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'apiVersion' => 1,
	'updatedAt' => 1000,
	'entries' => ['reading' => ['updatedAt' => 1000, 'value' => ['textScale' => 0.7]]],
]);
check('an older write is refused rather than clobbering', $stale->status === 409 && $stale->body['error']['code'] === 'stale_preferences');
check(
	'and it hands back the winning document, so a loser need not ask twice',
	($stale->body['preferences']['entries']['reading']['value']['textScale'] ?? 0) === 1.3
		&& ($stale->body['preferences']['updatedAt'] ?? 0) === 2000
);
check('the refusal changed nothing', ($fresh->load()['entries']['reading']['value']['textScale'] ?? 0) === 1.3);

$same = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'updatedAt' => 2000,
	'entries' => ['reading' => ['updatedAt' => 2000, 'value' => ['textScale' => 1.6]]],
]);
check('the same stamp may replace the document', $same->status === 200 && ($fresh->load()['entries']['reading']['value']['textScale'] ?? 0) === 1.6);

$noStamp = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'entries' => ['reading' => ['updatedAt' => 2100, 'value' => ['textScale' => 1.1]]],
]);
check('a document cannot make itself newer than its entries', $noStamp->status === 200 && $noStamp->body['updatedAt'] === 2100, json_encode($noStamp->body));

$partial = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'updatedAt' => 2200,
	'entries' => ['search' => ['updatedAt' => 2200, 'value' => ['deep' => true]]],
]);
check('a client that sends one namespace is accepted', $partial->status === 200);
$after = $fresh->load();
check(
	'and the namespaces it did not mention are kept, not pruned',
	($after['entries']['reading']['value']['textScale'] ?? 0) === 1.1
		&& ($after['entries']['theme']['value']['mode'] ?? '') === 'light'
		&& ($after['entries']['search']['value']['deep'] ?? false) === true,
	json_encode($after['entries'])
);

$emptyMap = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', [
	'updatedAt' => 9999999999999,
	'entries' => [],
]);
check('an empty map changes nothing and claims nothing', $emptyMap->status === 200 && $emptyMap->body['updatedAt'] === 2200, json_encode($emptyMap->body));
check('the stored document survived it', ($fresh->load()['entries']['reading']['value']['textScale'] ?? 0) === 1.1);

$bad = api($fresh, $calls)->dispatch('PUT', 'v1/preferences', 'good', ['updatedAt' => 5000]);
check('a write with no entries is a 400', $bad->status === 400 && $bad->body['error']['code'] === 'invalid_preferences');

$wrongMethod = api($fresh, $calls)->dispatch('POST', 'v1/preferences', 'good');
check('the route says which methods it takes', $wrongMethod->status === 405 && $wrongMethod->headers['Allow'] === 'GET, PUT');

$bare = api(null, $calls)->dispatch('GET', 'v1/preferences', 'good');
check('a server without a store says so instead of pretending', $bare->status === 503 && $bare->body['error']['code'] === 'preferences_unavailable');

echo "\n{$checks} checks, {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
