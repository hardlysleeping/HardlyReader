<?php
declare(strict_types=1);

/**
 * Do the lock routes answer on both shapes of Hidden Categories?
 *
 *   php tests/lock-shapes.php
 *
 * The app locks through POST /v1/lock, POST /v1/unlock and PUT /v1/passcode.
 * Hidden Categories keeps those three on its *store*; the PHPUnit fakes put
 * them on the extension object. The API used to demand the second shape, so a
 * server with the first answered 409 extension_incompatible — or, when the
 * routes were missing from the deployed build altogether, "Unknown route.".
 * Both shapes are exercised here, with plain PHP and no user state.
 */

require __DIR__ . '/../lib/HardlyReadApi.php';

final class ShapeStore
{
	public string $code = '';
	public bool $locked = false;
	public array $hidden = [3];
	public function hiddenIds(): array { return $this->hidden; }
	public function mode(): string { return 'hide'; }
	public function view(): string { return 'hidden'; }
	public function isLocked(): bool { return $this->locked; }
	public function hasPasscode(): bool { return $this->code !== ''; }
	public function setPasscode(string $code): array
	{
		if ($code !== '' && !preg_match('/^[0-9]{1,6}$/', $code)) {
			return ['ok' => false, 'message' => 'Passcode must be 1 to 6 digits, numbers only.'];
		}
		$this->code = $code;
		return ['ok' => true, 'message' => 'Passcode saved.'];
	}
	public function lock(): array
	{
		if (!$this->hasPasscode()) {
			return ['ok' => false, 'message' => 'Set a passcode first — there is nothing to lock with.'];
		}
		$this->locked = true;
		return ['ok' => true, 'message' => 'Locked.'];
	}
	public function unlock(?string $given): array
	{
		if (!$this->locked) {
			return ['ok' => true, 'message' => 'Already unlocked.'];
		}
		if (!is_string($given) || !hash_equals($this->code, $given)) {
			return ['ok' => false, 'message' => 'Wrong passcode.'];
		}
		$this->locked = false;
		return ['ok' => true, 'message' => 'Unlocked.'];
	}
}

/** The deployed shape: curtain controls on the store only. */
class ShapeStoreOnly
{
	public ShapeStore $store;
	public function __construct() { $this->store = new ShapeStore(); }
	public function store(): ShapeStore { return $this->store; }
	public function effectiveView(): string { return 'hidden'; }
	public function categories(): array { return [['id' => 3, 'name' => 'Art', 'hidden' => true]]; }
}

/** The fakes' shape: the extension forwards the three methods itself. */
final class ShapeForwarding extends ShapeStoreOnly
{
	public function lock(): array { return $this->store->lock(); }
	public function unlock(?string $given): array { return $this->store->unlock($given); }
	public function setPasscode(string $code): array { return $this->store->setPasscode($code); }
}

$failures = 0;
$checks = 0;

function api(object $hidden): HardlyReadApi
{
	return new HardlyReadApi(
		static fn (string $auth): ?string => $auth === 'Bearer good' ? 'tester' : null,
		static fn (string $u): ?object => $hidden,
		static fn (string $u): ?object => null,
		static fn (string $u): ?object => null,
	);
}

/**
 * @return array{0:int,1:string} status and error code (or "ok")
 */
function call(HardlyReadApi $api, string $method, string $route, array $body = []): array
{
	$response = $api->dispatch($method, '/v1/' . $route, 'Bearer good', $body);
	return [$response->status, $response->body['error']['code'] ?? 'ok'];
}

function check(string $label, bool $ok, string $detail = ''): void
{
	global $failures, $checks;
	$checks += 1;
	if (!$ok) {
		$failures += 1;
		echo "  FAIL {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
	}
}

foreach (['store only' => new ShapeStoreOnly(), 'forwarding' => new ShapeForwarding()] as $label => $hidden) {
	$api = api($hidden);
	[$status, $code] = call($api, 'POST', 'lock');
	check("[{$label}] locking without a passcode is refused, not unknown", $status === 409 && $code === 'passcode_required', "{$status} {$code}");

	[$status, $code] = call($api, 'PUT', 'passcode', ['passcode' => '1234']);
	check("[{$label}] a passcode can be set", $status === 200 && $code === 'ok', "{$status} {$code}");

	[$status, $code] = call($api, 'POST', 'lock');
	check("[{$label}] locking works", $status === 200 && $code === 'ok', "{$status} {$code}");

	[$status, $code] = call($api, 'POST', 'unlock', ['passcode' => '9999']);
	check("[{$label}] a wrong passcode is refused", $status === 403 && $code === 'wrong_passcode', "{$status} {$code}");

	[$status, $code] = call($api, 'POST', 'unlock', ['passcode' => '1234']);
	check("[{$label}] the right passcode unlocks", $status === 200 && $code === 'ok', "{$status} {$code}");

	[$status, $code] = call($api, 'PUT', 'passcode', ['passcode' => '12ab']);
	check("[{$label}] letters are refused", $status === 400 && $code === 'invalid_passcode', "{$status} {$code}");

	[$status, $code] = call($api, 'POST', 'not-a-route');
	check("[{$label}] an unknown route is still unknown", $status === 404 && $code === 'route_not_found', "{$status} {$code}");
}

echo $failures === 0
	? "{$checks}/{$checks} checks passed\n"
	: ($checks - $failures) . "/{$checks} checks passed, {$failures} failed\n";

exit($failures === 0 ? 0 : 1);
