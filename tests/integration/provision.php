<?php
declare(strict_types=1);

/**
 * Harness provisioning for tests/integration/run.sh.
 *
 * Runs inside the FreshRSS container; never against a live instance. Three
 * modes, because they need different privileges:
 *
 *   config  (root)      enable both extensions, seed the fixture categories
 *   reset   (www-data)  clear the extension's own state so a rerun starts clean
 *   dump    (any)       print that state as JSON, for the E2E to compare against
 *
 * `reset` must not run as root: it creates data/users/itest/extensions/..., and
 * a root-owned store directory would leave the web server (www-data) unable to
 * write the first hide. `config` must run as root, because data/config.php is
 * root-owned.
 */

const ROOT = '/var/www/FreshRSS';
const USER = 'itest';

/** Fixture categories, with fixed ids so assertions can name them. */
const CATEGORIES = [
	101 => 'E2E Alpha',
	102 => 'E2E Beta',
	103 => 'E2E Gamma',
];

const HIDDEN_EXTENSION = 'Hidden Categories';
const PINNED_EXTENSION = 'Pinned Categories';
const API_EXTENSION = 'Hardly Read';

$mode = $argv[1] ?? '';

if (!in_array($mode, ['config', 'reset', 'dump'], true)) {
	fwrite(STDERR, "usage: provision.php config|reset|dump\n");
	exit(2);
}

/** Reads a FreshRSS config file, merges `extensions_enabled`, writes it back. */
function enableExtensions(string $file, array $names): array
{
	if (!is_file($file)) {
		fwrite(STDERR, "missing config file: {$file}\n");
		exit(3);
	}
	$conf = include $file;
	if (!is_array($conf)) {
		fwrite(STDERR, "not a config array: {$file}\n");
		exit(3);
	}

	$enabled = is_array($conf['extensions_enabled'] ?? null) ? $conf['extensions_enabled'] : [];
	$changed = false;
	foreach ($names as $name) {
		if (empty($enabled[$name])) {
			$enabled[$name] = true;
			$changed = true;
		}
	}

	if ($changed) {
		$conf['extensions_enabled'] = $enabled;
		$php = "<?php\nreturn " . var_export($conf, true) . ";\n";
		// Write through the existing inode: the file keeps its owner, so the
		// web server can still read it.
		if (file_put_contents($file, $php) === false) {
			fwrite(STDERR, "could not write {$file}\n");
			exit(4);
		}
	}

	return array_keys($enabled);
}

/** Boots FreshRSS far enough to reach an extension's code in CLI. */
function bootExtensionManager(): void
{
	require ROOT . '/constants.php';
	require LIB_PATH . '/lib_rss.php';

	Minz_Session::init('FreshRSS', volatile: true);
	FreshRSS_Context::initSystem();
	FreshRSS_Context::initUser(USER);
	Minz_Translate::init('en');
	Minz_ExtensionManager::init();
}

/** @return object The Hidden Categories extension, or a fatal error. */
function hiddenExtension(): object
{
	$extension = Minz_ExtensionManager::findExtension(HIDDEN_EXTENSION);
	if ($extension === null) {
		fwrite(STDERR, HIDDEN_EXTENSION . " is not installed in the container\n");
		exit(5);
	}
	return $extension;
}

/** @return list<array{id:int,name:string,hidden:bool}> */
function storeState(object $extension): array
{
	$store = $extension->store();
	$hidden = $store->hiddenIds();

	$categories = [];
	foreach ($extension->categories() as $row) {
		$categories[] = [
			'id' => (int) $row['id'],
			'name' => (string) $row['name'],
			'hidden' => in_array((int) $row['id'], $hidden, true),
		];
	}

	return $categories;
}

if ($mode === 'config') {
	$system = enableExtensions(ROOT . '/data/config.php', [API_EXTENSION]);
	$user = enableExtensions(ROOT . '/data/users/' . USER . '/config.php', [HIDDEN_EXTENSION, PINNED_EXTENSION, API_EXTENSION]);

	// Fixture categories. FreshRSS has no API that creates an empty category,
	// and subscribing to a real feed would make this depend on outbound
	// network — so the rows are written directly, with fixed ids.
	$dbFile = ROOT . '/data/users/' . USER . '/db.sqlite';
	$pdo = new PDO('sqlite:' . $dbFile, null, null, [
		PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
	]);
	$insert = $pdo->prepare('INSERT OR IGNORE INTO category (id, name, kind) VALUES (:id, :name, 0)');
	foreach (CATEGORIES as $id => $name) {
		$insert->execute([':id' => $id, ':name' => $name]);
	}

	echo json_encode([
		'extensions' => ['system' => $system, 'user' => $user],
		'seeded' => CATEGORIES,
	], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
	exit(0);
}

if ($mode === 'reset') {
	bootExtensionManager();
	$extension = hiddenExtension();

	$store = $extension->store();
	// The store is lazy: only assertSchema() creates the directory, the file
	// and the tables. Without it the first write has nowhere to go.
	if (!$store->assertSchema() || !$store->available()) {
		fwrite(STDERR, 'store unavailable: ' . $store->error() . PHP_EOL);
		exit(6);
	}

	// The pin lock is armed with 0000 on first enable, and v1 has no unlock
	// route — deliberately, since misc.php carries no session. The harness
	// therefore runs with the lock disabled (the same state the owner gets
	// after clearing the passcode in the extension settings).
	$store->setPasscode('');
	$store->setView('hidden');

	$pdo = new PDO('sqlite:' . $store->path(), null, null, [
		PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
	]);
	$pdo->exec('DELETE FROM hidden_cat');

	// Pinned Categories is installed beside it, so its store is reset too: a rerun
	// over a kept volume must start with nothing pinned, or the first assertion
	// about an empty state would be reading the previous run's pins.
	$favorites = ['available' => false];
	$pinned = Minz_ExtensionManager::findExtension(PINNED_EXTENSION);
	if ($pinned !== null && method_exists($pinned, 'store')) {
		$favStore = $pinned->store();
		if ($favStore->assertSchema() && $favStore->available()) {
			$favPdo = new PDO('sqlite:' . $favStore->path(), null, null, [
				PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
			]);
			foreach (['fav_cat', 'cat_snap', 'feed_snap'] as $table) {
				$favPdo->exec('DELETE FROM ' . $table);
			}
			$favStore->setView('all');
			$favorites = [
				'available' => true,
				'store' => $favStore->path(),
				'view' => $favStore->view(),
				'ids' => array_map('intval', (array) $favStore->favIds()),
			];
		} else {
			$favorites = ['available' => false, 'error' => $favStore->error()];
		}
	}

	echo json_encode([
		'store' => $store->path(),
		'locked' => $store->isLocked(),
		'view' => $store->view(),
		'hiddenIds' => $store->hiddenIds(),
		'categories' => storeState($extension),
		'favorites' => $favorites,
	], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
	exit(0);
}

// dump: read-only, so it is safe after a failure as well as after a pass.
// Nothing here creates or repairs the store: a dump of a missing store has to
// say "missing", not quietly build one.
bootExtensionManager();
$extension = hiddenExtension();
$store = $extension->store();

$dump = [
	'store' => $store->path(),
	'exists' => is_file($store->path()),
	'available' => $store->available(),
	'error' => $store->error(),
];

if ($dump['exists']) {
	$dump['mode'] = $store->mode();
	$dump['view'] = $store->view();
	$dump['locked'] = $store->isLocked();
	$dump['passcodeSet'] = $store->hasPasscode();
	$dump['hiddenIds'] = $store->hiddenIds();
	$dump['categories'] = storeState($extension);
} else {
	$dump['mode'] = null;
	$dump['view'] = null;
	$dump['locked'] = null;
	$dump['passcodeSet'] = null;
	$dump['hiddenIds'] = [];
	$dump['categories'] = [];
}

// Pinned Categories is dumped on the same read-only terms: report, never repair.
$dump['favorites'] = ['available' => false];
$pinned = Minz_ExtensionManager::findExtension(PINNED_EXTENSION);
if ($pinned !== null && method_exists($pinned, 'store')) {
	$favStore = $pinned->store();
	$dump['favorites'] = $favStore->available()
		? [
			'available' => true,
			'store' => $favStore->path(),
			'view' => $favStore->view(),
			'ids' => array_map('intval', (array) $favStore->favIds()),
		]
		: ['available' => false, 'error' => $favStore->error()];
}

echo json_encode($dump, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
