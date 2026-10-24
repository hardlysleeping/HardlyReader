<?php
declare(strict_types=1);

/**
 * Checks for the sidebar-arrangement routes and their store.
 *
 *   docker cp <ext> hr:/tmp/hrpos && docker exec hr php /tmp/hrpos/tests/positions.php
 *
 * Plain PHP, no framework: there is no phpunit on this host, in the Arch
 * distrobox, or in the FreshRSS container (same reason `lock-shapes.php` is
 * plain). What is checked here is the contract the client depends on — auth
 * first, two lists in one document, last write wins by timestamp, and the file
 * surviving a round trip.
 */

// DATA_PATH is only needed by dirForUser(); the store itself takes a directory.
if (!defined('DATA_PATH')) {
	define('DATA_PATH', sys_get_temp_dir() . '/hrpos-data');
}

require_once __DIR__ . '/../lib/HardlyReadApiResponse.php';
require_once __DIR__ . '/../lib/HardlyReadPositionStore.php';
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

$dir = sys_get_temp_dir() . '/hrpos-' . bin2hex(random_bytes(4));
mkdir($dir, 0770, true);

// ---------------------------------------------------------------- the store

$store = new HardlyReadPositionStore($dir);
$empty = $store->load();
check('an unwritten store reads as empty', $empty['categories'] === [] && $empty['feeds'] === [] && $empty['updatedAt'] === 0);

$doc = [
	'updatedAt' => 1761000000000,
	'categories' => ['user/-/label/Design', 'user/-/label/Tech', 'user/-/label/Design'],
	'feeds' => ['feed/3', 'feed/1', ''],
];
check('a save reports success', $store->save($doc) === true);
$back = $store->load();
check('the arrangement round trips', $back['categories'] === ['user/-/label/Design', 'user/-/label/Tech'], json_encode($back));
check('duplicates and blanks are dropped, not stored', $back['feeds'] === ['feed/3', 'feed/1'], json_encode($back['feeds']));
check('the timestamp survives', $back['updatedAt'] === 1761000000000);
check('the file is not world readable', (fileperms($store->file()) & 0007) === 0, decoct(fileperms($store->file())));

file_put_contents($store->file(), '{not json');
check('a corrupt file reads as empty instead of throwing', $store->load()['categories'] === []);

$huge = ['updatedAt' => 1, 'categories' => array_map(fn (int $i): string => 'cat-' . $i, range(1, HardlyReadPositionStore::MAX_ENTRIES + 10)), 'feeds' => []];
$store->save($huge);
check('one list is capped rather than unbounded', count($store->load()['categories']) === HardlyReadPositionStore::MAX_ENTRIES);

$long = ['updatedAt' => 1, 'categories' => [str_repeat('a', HardlyReadPositionStore::MAX_ID_LENGTH + 1)], 'feeds' => []];
$store->save($long);
check('an id longer than the cap is dropped', $store->load()['categories'] === []);

// A traversal attempt in the login must not build a path outside the users dir.
$refused = false;
try {
	HardlyReadPositionStore::dirForUser('../../etc');
} catch (InvalidArgumentException $e) {
	$refused = true;
}
check('a login that is not a username cannot name a directory', $refused);
check(
	'an ordinary login lands under that user',
	str_contains(HardlyReadPositionStore::dirForUser('alice'), '/users/alice/extensions/HardlyRead'),
);

// ---------------------------------------------------------------- the router

function api(?HardlyReadPositionStore $store, array &$calls = []): HardlyReadApi
{
	return new HardlyReadApi(
		authenticate: function (string $auth): ?string {
			return $auth === 'good' ? 'alice' : null;
		},
		loadHiddenCategories: fn (string $u): ?object => null,
		loadFavorites: fn (string $u): ?object => null,
		loadSidebarIndent: fn (string $u): ?object => null,
		loadPositions: $store === null ? null : function (string $u) use ($store, &$calls): array {
			$calls[] = "load:{$u}";
			return $store->load();
		},
		savePositions: $store === null ? null : function (string $u, array $doc) use ($store, &$calls): bool {
			$calls[] = "save:{$u}";
			return $store->save($doc);
		},
	);
}

$fresh = new HardlyReadPositionStore($dir . '/router');
$calls = [];
$response = api($fresh, $calls)->dispatch('GET', 'v1/positions', '');
check('an unauthenticated read is refused before anything is stored', $response->status === 401 && $calls === []);

$response = api($fresh, $calls)->dispatch('GET', 'v1/positions', 'good');
check('an empty arrangement is a 200, not a 404', $response->status === 200);
check('and it answers with both lists', $response->body['categories'] === [] && $response->body['feeds'] === []);

$write = api($fresh, $calls)->dispatch('PUT', 'v1/positions', 'good', [
	'updatedAt' => 2000,
	'categories' => ['user/-/label/Tech', 'user/-/label/Design'],
	'feeds' => ['feed/2', 'feed/1'],
]);
check('a write is accepted', $write->status === 200 && $write->body['categories'][0] === 'user/-/label/Tech');

$read = api($fresh, $calls)->dispatch('GET', 'v1/positions', 'good');
check('and the next read on another device sees it', $read->body['categories'] === ['user/-/label/Tech', 'user/-/label/Design']);

$stale = api($fresh, $calls)->dispatch('PUT', 'v1/positions', 'good', [
	'updatedAt' => 1000,
	'categories' => ['user/-/label/Old'],
	'feeds' => [],
]);
check('an older write is refused rather than clobbering', $stale->status === 409 && $stale->body['error']['code'] === 'stale_positions');
check('and it says which timestamp won', ($stale->body['updatedAt'] ?? 0) === 2000);
check(
	'and hands back the winning arrangement, so a loser need not ask twice',
	($stale->body['categories'] ?? null) === ['user/-/label/Tech', 'user/-/label/Design']
		&& ($stale->body['feeds'] ?? null) === ['feed/2', 'feed/1']
);
check('the refuse changed nothing', $fresh->load()['categories'] === ['user/-/label/Tech', 'user/-/label/Design']);

$same = api($fresh, $calls)->dispatch('PUT', 'v1/positions', 'good', [
	'updatedAt' => 2000,
	'categories' => ['user/-/label/Design', 'user/-/label/Tech'],
	'feeds' => [],
]);
check('the same timestamp may replace the document', $same->status === 200 && $same->body['categories'][0] === 'user/-/label/Design');

$noStamp = api($fresh, $calls)->dispatch('PUT', 'v1/positions', 'good', ['categories' => ['a'], 'feeds' => []]);
check('a write with no timestamp gets one from the server', $noStamp->status === 200 && $noStamp->body['updatedAt'] > 0);

$bad = api($fresh, $calls)->dispatch('PUT', 'v1/positions', 'good', ['categories' => 'not a list']);
check('a list that is not a list is a 400', $bad->status === 400 && $bad->body['error']['code'] === 'invalid_positions');

$wrongMethod = api($fresh, $calls)->dispatch('POST', 'v1/positions', 'good');
check('the route says which methods it takes', $wrongMethod->status === 405 && $wrongMethod->headers['Allow'] === 'GET, PUT');

$bare = api(null, $calls)->dispatch('GET', 'v1/positions', 'good');
check('a server without a store still answers, empty', $bare->status === 200 && $bare->body['categories'] === []);
$bareWrite = api(null, $calls)->dispatch('PUT', 'v1/positions', 'good', ['categories' => []]);
check('but a write to it is a 503, not a silent success', $bareWrite->status === 503 && $bareWrite->body['error']['code'] === 'positions_unavailable');

echo "\n{$checks} checks, {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
