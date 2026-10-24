<?php
declare(strict_types=1);

/**
 * Do the /v1/people routes answer correctly, with and without a provider?
 *
 *   php tests/people.php
 *
 * Plain PHP, no framework, no PHPUnit: this is meant to be run against a
 * staged copy of lib/ inside the FreshRSS container, where the real provider
 * may or may not be installed. Nothing here reaches the network — the helper's
 * transport is injected, so every provider answer below is a fixture.
 *
 * The provider's own files are never read: the fixture root is a temporary
 * directory built and removed by this script.
 */

require __DIR__ . '/../lib/HardlyReadApi.php';
require __DIR__ . '/../lib/HardlyReadPeople.php';

const AUTH = 'GoogleLogin auth=alice/fixture-token';

/** One row of the provider's list: name, slug, tick mask, then an alias. */
const LIST_BODY = 'window.NAMES='
	. '[["Ada Lovelace","ada-lovelace",3],'
	. '["Test Person","test-person",1],'
	. '["Test-Person","test-person-2",2],'
	. '["Grace Hopper","grace-hopper",2,"Amazing Grace"]];';

/** Already followed: one by slug, one by name (through its alias). */
const SUBS_BODY = '{"ok":true,"subs":["test-person"],"names":["amazinggrace"],"err":null}';

$failures = 0;
$checks = 0;

function check(string $label, bool $ok, string $detail = ''): void
{
	global $failures, $checks;
	$checks += 1;
	if (!$ok) {
		$failures += 1;
		echo "  FAIL {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
	}
}

/** A staging root; the provider can be present, half-installed, or absent. */
function root(string $state): string
{
	$root = sys_get_temp_dir() . '/hardlyread-people-' . bin2hex(random_bytes(4));
	mkdir($root . '/p', 0777, true);
	mkdir($root . '/extensions/' . HardlyReadPeople::DIRECTORY, 0777, true);

	if ($state !== 'absent') {
		file_put_contents($root . '/p/' . HardlyReadPeople::PAGE, "<?php\n");
	}
	if ($state === 'complete') {
		file_put_contents(
			$root . '/extensions/' . HardlyReadPeople::DIRECTORY . '/' . HardlyReadPeople::TOKEN_FILE,
			"<?php\ndefine(HardlyReadPeople::TOKEN_CONSTANT, 'fixture-token');\n",
		);
	}

	return $root;
}

function removeRoot(string $root): void
{
	foreach ([
		$root . '/extensions/' . HardlyReadPeople::DIRECTORY . '/' . HardlyReadPeople::TOKEN_FILE,
		$root . '/p/' . HardlyReadPeople::PAGE,
	] as $file) {
		if (is_file($file)) {
			unlink($file);
		}
	}
	@rmdir($root . '/extensions/' . HardlyReadPeople::DIRECTORY);
	@rmdir($root . '/extensions');
	@rmdir($root . '/p');
	@rmdir($root);
}

/**
 * The helper with a fixed transport. $answers is keyed by 'list', 'subs' and
 * 'add'; a missing key means "nothing answered", i.e. a timeout.
 *
 * @param array<string, array{status: int, body: string}|null> $answers
 * @param list<string> $calls Receives every request the helper made.
 */
function provider(string $root, array $answers, array &$calls = []): HardlyReadPeople
{
	return HardlyReadPeople::create($root, static function (string $what, string $name = '') use ($answers, &$calls): ?array {
		$calls[] = $name === '' ? $what : $what . ':' . $name;
		return $answers[$what] ?? null;
	});
}

function api(?HardlyReadPeople $provider): HardlyReadApi
{
	return new HardlyReadApi(
		authenticate: static fn (string $authorization): ?string
			=> $authorization === AUTH ? 'alice' : null,
		loadHiddenCategories: static fn (string $username): ?object => null,
		loadFavorites: static fn (string $username): ?object => null,
		loadSidebarIndent: static fn (string $username): ?object => null,
		loadPeople: static fn (): ?object => $provider,
	);
}

/** A router built the way it was before the provider existed. */
function apiWithoutLoader(): HardlyReadApi
{
	return new HardlyReadApi(
		authenticate: static fn (string $authorization): ?string
			=> $authorization === AUTH ? 'alice' : null,
		loadHiddenCategories: static fn (string $username): ?object => null,
		loadFavorites: static fn (string $username): ?object => null,
		loadSidebarIndent: static fn (string $username): ?object => null,
	);
}

function code(HardlyReadApiResponse $response): string
{
	return is_string($response->body['error']['code'] ?? null) ? $response->body['error']['code'] : 'ok';
}

$absent = root('absent');
$half = root('half');
$complete = root('complete');

// --------------------------------------------------------------- presence --

check('a root with no provider page is not a provider', HardlyReadPeople::create($absent) === null);
check('a page without a token source is not a provider', HardlyReadPeople::create($half) === null);
check('a complete provider is found', HardlyReadPeople::create($complete) !== null);

// ------------------------------------------------------- absent provider --

$noProvider = api(null);

$response = $noProvider->dispatch('GET', '/v1/people/status', AUTH);
check(
	'absent: status is an unknown route, not an empty 200',
	$response->status === 404 && code($response) === 'route_not_found',
	"{$response->status} " . code($response),
);

$response = $noProvider->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'Ada']);
check(
	'absent: search is an unknown route',
	$response->status === 404 && code($response) === 'route_not_found',
	"{$response->status} " . code($response),
);
check('absent: the 404 carries no people list', !array_key_exists('people', $response->body));

$response = $noProvider->dispatch('POST', '/v1/people', AUTH, ['name' => 'Ada Lovelace']);
check(
	'absent: add is an unknown route',
	$response->status === 404 && code($response) === 'route_not_found',
	"{$response->status} " . code($response),
);

$response = $noProvider->dispatch('GET', '/v1/state', AUTH);
check('absent: state says peopleAvailable false', $response->body['peopleAvailable'] === false);

$response = apiWithoutLoader()->dispatch('GET', '/v1/state', AUTH);
check('no loader at all: state still says peopleAvailable false', $response->body['peopleAvailable'] === false);
$response = apiWithoutLoader()->dispatch('GET', '/v1/people', AUTH);
check(
	'no loader at all: the routes are unknown',
	$response->status === 404 && code($response) === 'route_not_found',
	"{$response->status} " . code($response),
);

// ---------------------------------------------------------------- status --

$calls = [];
$good = provider($complete, [
	'list' => ['status' => 200, 'body' => LIST_BODY],
	'subs' => ['status' => 200, 'body' => SUBS_BODY],
	'add' => ['status' => 200, 'body' => '{"ok":true,"message":"added 2 feeds"}'],
], $calls);
check('a complete provider is usable', $good !== null);
$served = api($good);

$response = $served->dispatch('GET', '/v1/people/status', AUTH);
check(
	'status: enabled, and nothing else',
	$response->status === 200 && $response->body === ['enabled' => true],
	$response->status . ' ' . json_encode($response->body),
);
check('status: asks the provider for nothing', $calls === [], implode(',', $calls));

$response = $served->dispatch('POST', '/v1/people/status', AUTH);
check(
	'status: a POST is refused with an Allow header',
	$response->status === 405 && ($response->headers['Allow'] ?? '') === 'GET',
	$response->status . ' ' . json_encode($response->headers),
);

// ---------------------------------------------------------------- search --

$response = $served->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'ada']);
check('search: 200 and enabled', $response->status === 200 && $response->body['enabled'] === true);
check(
	'search: one match, parsed and not yet added',
	($response->body['people'] ?? null) === [['name' => 'Ada Lovelace', 'added' => false]],
	json_encode($response->body),
);
check('search: no failure message on a real answer', !array_key_exists('message', $response->body));
check(
	'search: a row carries name and added only',
	array_keys($response->body['people'][0] ?? []) === ['name', 'added'],
	json_encode($response->body['people'][0] ?? null),
);

$response = $served->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'test']);
$people = $response->body['people'] ?? [];
check('search: two spellings of one person collapse to one row', count($people) === 1, json_encode($people));
check('search: an already-followed person is marked added', ($people[0]['added'] ?? null) === true, json_encode($people));

$response = $served->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'grace']);
check(
	'search: the alias counts as the same person',
	($response->body['people'][0]['name'] ?? null) === 'Grace Hopper'
		&& ($response->body['people'][0]['added'] ?? null) === true,
	json_encode($response->body),
);

$calls = [];
$response = $served->dispatch('GET', '/v1/people', AUTH);
check(
	'search: an empty query is an empty list with no message',
	($response->body['people'] ?? null) === [] && !array_key_exists('message', $response->body),
	json_encode($response->body),
);
check('search: an empty query does not fetch', $calls === [], implode(',', $calls));

$response = $served->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'zzzznobody']);
check(
	'search: no match is an empty list, not an error',
	($response->body['people'] ?? null) === [] && !array_key_exists('message', $response->body),
	json_encode($response->body),
);

$response = $served->dispatch('GET', '/v1/people/anything', AUTH);
check(
	'search: an unknown sub-route is still unknown',
	$response->status === 404 && code($response) === 'route_not_found',
	"{$response->status} " . code($response),
);

$response = $served->dispatch('PUT', '/v1/people', AUTH, ['name' => 'Ada Lovelace']);
check(
	'route: a PUT is refused with both allowed methods',
	$response->status === 405 && ($response->headers['Allow'] ?? '') === 'GET, POST',
	$response->status . ' ' . json_encode($response->headers),
);

// ------------------------------------------------------------- failures --

$timedOut = api(provider($complete, [
	'subs' => ['status' => 200, 'body' => SUBS_BODY],
]));
$response = $timedOut->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'ada']);
check(
	'timeout on the list: enabled, empty, and a message',
	$response->status === 200
		&& $response->body['enabled'] === true
		&& ($response->body['people'] ?? null) === []
		&& is_string($response->body['message'] ?? null)
		&& $response->body['message'] !== '',
	json_encode($response->body),
);

$timedOut = api(provider($complete, [
	'list' => ['status' => 200, 'body' => LIST_BODY],
]));
$response = $timedOut->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'ada']);
check(
	'timeout on the subscribed list: a message, never silent rows',
	($response->body['people'] ?? null) === [] && is_string($response->body['message'] ?? null),
	json_encode($response->body),
);

$garbled = api(provider($complete, [
	'list' => ['status' => 200, 'body' => '<html>nope</html>'],
	'subs' => ['status' => 200, 'body' => SUBS_BODY],
]));
$response = $garbled->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'ada']);
check(
	'an unreadable list: a message, not an empty success',
	($response->body['people'] ?? null) === [] && is_string($response->body['message'] ?? null),
	json_encode($response->body),
);

$garbled = api(provider($complete, [
	'list' => ['status' => 200, 'body' => LIST_BODY],
	'subs' => ['status' => 200, 'body' => '{"ok":false,"subs":[]}'],
]));
$response = $garbled->dispatch('GET', '/v1/people', AUTH, [], ['q' => 'ada']);
check(
	'a refused subscribed list: a message, not every row "not added"',
	($response->body['people'] ?? null) === [] && is_string($response->body['message'] ?? null),
	json_encode($response->body),
);

// ------------------------------------------------------------------- add --

$calls = [];
$served = api(provider($complete, [
	'add' => ['status' => 200, 'body' => '{"ok":true,"message":"added 2 feeds"}'],
], $calls));
$response = $served->dispatch('POST', '/v1/people', AUTH, ['name' => '  Ada Lovelace  ']);
check(
	'add: a success is parsed through',
	$response->status === 200
		&& ($response->body['ok'] ?? null) === true
		&& ($response->body['message'] ?? null) === 'added 2 feeds',
	json_encode($response->body),
);
check('add: the name is trimmed before it is sent', $calls === ['add:Ada Lovelace'], implode(',', $calls));

$served = api(provider($complete, [
	'add' => ['status' => 200, 'body' => '{"ok":false,"message":"no feeds found"}'],
]));
$response = $served->dispatch('POST', '/v1/people', AUTH, ['name' => 'Test Person']);
check(
	'add: a provider refusal is a 200 with ok false and its message',
	$response->status === 200
		&& ($response->body['ok'] ?? null) === false
		&& ($response->body['message'] ?? null) === 'no feeds found',
	json_encode($response->body),
);

$served = api(provider($complete, []));
$response = $served->dispatch('POST', '/v1/people', AUTH, ['name' => 'Test Person']);
check(
	'add: a timeout is ok false with a message',
	$response->status === 200
		&& ($response->body['ok'] ?? null) === false
		&& is_string($response->body['message'] ?? null)
		&& $response->body['message'] !== '',
	json_encode($response->body),
);

$calls = [];
$served = api(provider($complete, [], $calls));
$response = $served->dispatch('POST', '/v1/people', AUTH, []);
check(
	'add: a missing name is a 400, not a fetch',
	$response->status === 400 && code($response) === 'invalid_name' && $calls === [],
	"{$response->status} " . code($response) . ' ' . implode(',', $calls),
);

$response = $served->dispatch('POST', '/v1/people', AUTH, ['name' => '   ']);
check(
	'add: a blank name is a 400',
	$response->status === 400 && code($response) === 'invalid_name',
	"{$response->status} " . code($response),
);

// ------------------------------------------------------------------ auth --

$response = $served->dispatch('GET', '/v1/people', 'GoogleLogin auth=alice/wrong', [], ['q' => 'ada']);
check(
	'auth: people is behind the same credential as everything else',
	$response->status === 401 && code($response) === 'unauthorized',
	"{$response->status} " . code($response),
);

$response = $served->dispatch('GET', '/v1/state', AUTH);
check('state: peopleAvailable true when a provider is there', $response->body['peopleAvailable'] === true);

// -------------------------------------------------------------- cleanup --

removeRoot($absent);
removeRoot($half);
removeRoot($complete);

echo $failures === 0
	? "{$checks}/{$checks} checks passed\n"
	: ($checks - $failures) . "/{$checks} checks passed, {$failures} failed\n";

exit($failures === 0 ? 0 : 1);
