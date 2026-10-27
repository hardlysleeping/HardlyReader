<?php
declare(strict_types=1);

/**
 * Where pairing tickets and device credentials live.
 *
 * Two files, two jobs:
 *
 *   tickets/<sha256(code)>.json   one ticket per pending code, server-wide
 *   devices.json                  one record per paired device, also server-wide
 *
 * **Why server-wide and not per user.** A ticket belongs to nobody until a
 * signed-in person approves it — that is the whole shape of the flow, and a
 * store that needed the account first could not hold a code a signed-out phone
 * just asked for. Credentials are indexed by account inside the record instead,
 * because authenticating a device means turning a token into a login, and a
 * per-user file would need the login before it could look the token up.
 *
 * **What is stored hashed.** Codes are stored as they are displayed: the
 * approving screen has to show them, and a five-minute, single-use secret that
 * somebody is reading off a phone is not a secret kept from the server. Device
 * tokens are the opposite: only their SHA-256 is written, so the file is not a
 * list of credentials, and a token can be revoked but never recovered.
 *
 * **Why a lock and not a rename.** Redeeming a ticket is a read-decide-write
 * across two files, and "single use" is exactly the guarantee two requests at
 * once would break. Each ticket is opened `c+` and held under `flock(LOCK_EX)`
 * for the whole decision, so the second caller sees `redeemedAt` set rather
 * than a ticket it can claim too. Writes are still truncate-and-write inside
 * that lock, never a rename, because the lock is on the handle.
 *
 * No FreshRSS class is touched, no user configuration is written, and the clock
 * and token mint are injectable so a test can walk a ticket through its whole
 * life without waiting five minutes.
 */
final class HardlyReadPairingStore
{
	/** Digits in a code. Eight, matching the app's `PAIRING_CODE_LENGTH`. */
	public const CODE_LENGTH = 8;

	/** How long a code may be approved and redeemed. Five minutes. */
	public const CODE_TTL_SECONDS = 300;

	/** Every device token begins with this, as in the app's `isDeviceToken()`. */
	public const TOKEN_PREFIX = 'hrd_';

	/** Bytes of randomness in a device token. */
	public const TOKEN_BYTES = 32;

	/** How long a credential lasts without being used. Ninety days, sliding. */
	public const CREDENTIAL_TTL_SECONDS = 7776000;

	/** How often a used credential's deadline is pushed out, at most. */
	public const TOUCH_SECONDS = 3600;

	/** A label is shown once, beside a code: a line, not an essay. */
	public const MAX_LABEL_BYTES = 40;

	/** Tickets deleted in one prune pass, so a busy server cannot stall a request. */
	private const PRUNE_LIMIT = 32;

	/** How many pending codes a settings panel is asked to draw at most. */
	private const PENDING_LIMIT = 8;

	private string $root;

	/** @var Closure(): int */
	private Closure $clock;

	/** @var Closure(): string */
	private Closure $mint;

	/**
	 * @param (callable(): int)|null $clock    unix seconds, for tests
	 * @param (callable(): string)|null $mint  the device token, for tests
	 */
	public function __construct(string $root, ?callable $clock = null, ?callable $mint = null)
	{
		$this->root = rtrim($root, '/');
		$this->clock = Closure::fromCallable($clock ?? static fn (): int => time());
		$this->mint = Closure::fromCallable(
			$mint ?? static fn (): string => self::TOKEN_PREFIX . bin2hex(random_bytes(self::TOKEN_BYTES))
		);
	}

	/**
	 * Where this server keeps its pairing state.
	 *
	 * Outside `users/`, deliberately: a ticket exists before it has an owner, and
	 * DATA_PATH is the one place FreshRSS guarantees is writable and private.
	 */
	public static function rootForServer(): string
	{
		return DATA_PATH . '/extensions/HardlyRead/pairing';
	}

	/* ---------------------------------------------------------------------
	 * A device asks
	 * ------------------------------------------------------------------ */

	/**
	 * A new code, and the ticket behind it.
	 *
	 * Nothing about the asking device is trusted beyond its label, and the label
	 * is a display name: the account is not known yet and must not be guessed
	 * from anything the caller sends.
	 *
	 * @return array{code: string, label: string, account: null, issuedAt: int, expiresAt: int, approvedAt: null, redeemedAt: null, revokedAt: null}
	 */
	public function issue(string $label): array
	{
		$now = $this->now();
		$code = self::newCode();
		$ticket = [
			'code' => $code,
			'label' => self::label($label),
			'account' => null,
			'issuedAt' => $now,
			'expiresAt' => $now + self::CODE_TTL_SECONDS,
			'approvedAt' => null,
			'redeemedAt' => null,
			'revokedAt' => null,
		];

		if (!$this->write($this->path($code), $ticket)) {
			throw new RuntimeException('Could not store a pairing ticket.');
		}
		$this->prune($now);

		return $ticket;
	}

	/**
	 * The codes waiting for a person to approve them, newest first.
	 *
	 * Only tickets that are still *approvable*: an expired, spent or withdrawn
	 * one is not something a person can act on, and drawing it would be a row
	 * whose button always fails.
	 *
	 * @return list<array{code: string, label: string, issuedAt: int, expiresAt: int}>
	 */
	public function pending(): array
	{
		$now = $this->now();
		$rows = [];
		foreach ($this->tickets() as $path) {
			$ticket = self::ticket(@file_get_contents($path));
			if ($ticket === null || self::state($ticket, $now) !== 'issued') {
				continue;
			}
			$rows[] = [
				'code' => $ticket['code'],
				'label' => $ticket['label'],
				'issuedAt' => $ticket['issuedAt'],
				'expiresAt' => $ticket['expiresAt'],
			];
		}

		// Newest first, and by code when two arrived in the same second: the rows
		// must not reshuffle on every poll just because the clock did not tick.
		usort($rows, static fn (array $a, array $b): int => ($b['issuedAt'] <=> $a['issuedAt']) ?: strcmp($b['code'], $a['code']));

		return array_slice($rows, 0, self::PENDING_LIMIT);
	}

	/* ---------------------------------------------------------------------
	 * A signed-in person approves
	 * ------------------------------------------------------------------ */

	/**
	 * Binds a code to the account that pressed approve.
	 *
	 * The press is the human check: this account was signed in already, which
	 * means the captcha was answered by a person at some point, and the press
	 * says "yes, that device, that code". From here the ticket is this account's:
	 * a second account approving it is refused rather than allowed to re-bind.
	 *
	 * @return array{ok: bool, reason?: string, pairing?: array}
	 */
	public function approve(string $code, string $account): array
	{
		if ($account === '') {
			return ['ok' => false, 'reason' => 'unauthorized'];
		}

		return $this->withTicket($code, function (array $ticket) use ($account): array {
			$now = $this->now();
			$state = self::state($ticket, $now);
			if ($state === 'revoked') {
				return self::refusal('revoked');
			}
			if ($state === 'expired') {
				return self::refusal('expired');
			}
			if ($state === 'redeemed') {
				return self::refusal('used');
			}
			if ($ticket['approvedAt'] !== null) {
				// The same account pressing twice is not an error; another one
				// taking a bound ticket would be a rebind, which is not a thing
				// a code may do.
				return $ticket['account'] === $account
					? ['ok' => true, 'pairing' => $ticket]
					: self::refusal('wrong_account');
			}

			$ticket['account'] = $account;
			$ticket['approvedAt'] = $now;

			return ['ok' => true, 'pairing' => $ticket, 'write' => true];
		});
	}

	/* ---------------------------------------------------------------------
	 * The device redeems
	 * ------------------------------------------------------------------ */

	/**
	 * Hands over one credential, once.
	 *
	 * The checks are ordered the way the phone needs the answers: is this even a
	 * code, is it somebody else's, is it dead, has it been used, has a human
	 * approved it yet. `not_approved` is last and is not a failure — it is the
	 * answer that means "keep asking".
	 *
	 * @param ?string $account the login the caller already belongs to, when it has one
	 *
	 * @return array{ok: bool, reason?: string, token?: string, account?: string, label?: string, pairedAt?: int, lastUsedAt?: int, expiresAt?: int, pairing?: array}
	 */
	public function redeem(string $code, ?string $account, string $label): array
	{
		return $this->withTicket($code, function (array $ticket) use ($account, $label): array {
			$now = $this->now();

			if ($account !== null && $ticket['account'] !== null && $ticket['account'] !== $account) {
				return self::refusal('wrong_account');
			}

			$state = self::state($ticket, $now);
			if ($state === 'revoked') {
				return self::refusal('revoked');
			}
			if ($state === 'redeemed') {
				return self::refusal('used');
			}
			if ($state === 'expired') {
				return self::refusal('expired');
			}
			if ($state === 'issued' || $ticket['account'] === null) {
				return self::refusal('not_approved');
			}

			$token = ($this->mint)();
			$device = [
				'hash' => self::hash($token),
				'account' => $ticket['account'],
				'label' => self::label($label !== '' ? $label : $ticket['label']),
				'pairedAt' => $now,
				'lastUsedAt' => $now,
				'expiresAt' => $now + self::CREDENTIAL_TTL_SECONDS,
				'revokedAt' => null,
			];
			if (!$this->addDevice($device)) {
				return ['ok' => false, 'reason' => 'store_failed'];
			}

			$ticket['redeemedAt'] = $now;

			return [
				'ok' => true,
				'pairing' => $ticket,
				'write' => true,
				'token' => $token,
				'account' => $device['account'],
				'label' => $device['label'],
				'pairedAt' => $device['pairedAt'],
				'lastUsedAt' => $device['lastUsedAt'],
				'expiresAt' => $device['expiresAt'],
			];
		});
	}

	/* ---------------------------------------------------------------------
	 * Both sides can withdraw
	 * ------------------------------------------------------------------ */

	/**
	 * Marks a credential dead, for the account that owns it.
	 *
	 * The account comes from the request's own credential, so a device can end
	 * its own sign-in and nobody else's. Idempotent: pressing revoke on an
	 * already-dead credential is a success, because the intent is satisfied.
	 *
	 * @return array{ok: bool, reason?: string}
	 */
	public function revoke(string $account, string $token): array
	{
		$hash = self::hash($token);
		if ($hash === null || $account === '') {
			return ['ok' => false, 'reason' => 'unauthorized'];
		}

		$devices = $this->devices();
		$found = false;
		foreach ($devices as $index => $device) {
			if ($device['hash'] !== $hash) {
				continue;
			}
			if ($device['account'] !== $account) {
				// Somebody else's credential: indistinguishable from one that
				// does not exist, so this route cannot be asked which tokens do.
				return ['ok' => false, 'reason' => 'unauthorized'];
			}
			$found = true;
			if ($device['revokedAt'] === null) {
				$devices[$index]['revokedAt'] = $this->now();
			}
		}

		if (!$found) {
			return ['ok' => false, 'reason' => 'unauthorized'];
		}

		return $this->saveDevices($devices) ? ['ok' => true] : ['ok' => false, 'reason' => 'store_failed'];
	}

	/* ---------------------------------------------------------------------
	 * Every request after pairing
	 * ------------------------------------------------------------------ */

	/**
	 * The login behind a device token, or null.
	 *
	 * Called on every authenticated request from a paired device, so it does as
	 * little as it can: one file read, a hash comparison, and — at most once an
	 * hour — a write that pushes the deadline out. A revoked or expired record
	 * answers null, which the caller turns into the same 401 a wrong password
	 * gets.
	 */
	public function authenticate(string $account, string $token): bool
	{
		$hash = self::hash($token);
		if ($hash === null || $account === '') {
			return false;
		}

		$now = $this->now();
		$devices = $this->devices();
		$touched = false;
		$found = false;
		foreach ($devices as $index => $device) {
			if ($device['hash'] !== $hash || $device['account'] !== $account) {
				continue;
			}
			if ($device['revokedAt'] !== null || $now >= $device['expiresAt']) {
				return false;
			}
			$found = true;
			if ($now - $device['lastUsedAt'] >= self::TOUCH_SECONDS) {
				$devices[$index]['lastUsedAt'] = $now;
				$devices[$index]['expiresAt'] = $now + self::CREDENTIAL_TTL_SECONDS;
				$touched = true;
			}
		}

		if ($touched) {
			$this->saveDevices($devices);
		}

		return $found;
	}

	/**
	 * The device records for one account, without their hashes.
	 *
	 * What a Devices list would draw. Not on any route yet; it is here because
	 * the test that matters most about this store — that no token is written in
	 * the clear — has to read the records to say so.
	 *
	 * @return list<array{label: string, pairedAt: int, lastUsedAt: int, expiresAt: int, revokedAt: ?int}>
	 */
	public function devicesFor(string $account): array
	{
		$rows = [];
		foreach ($this->devices() as $device) {
			if ($device['account'] !== $account || $device['revokedAt'] !== null) {
				continue;
			}
			$rows[] = [
				'label' => $device['label'],
				'pairedAt' => $device['pairedAt'],
				'lastUsedAt' => $device['lastUsedAt'],
				'expiresAt' => $device['expiresAt'],
				'revokedAt' => $device['revokedAt'],
			];
		}

		return $rows;
	}

	/* ---------------------------------------------------------------------
	 * The code
	 * ------------------------------------------------------------------ */

	/**
	 * The three states a stored ticket can be in, plus the one it waits into.
	 *
	 * Same precedence as the app's `pairingState()`: revocation outranks
	 * everything (a decision beats a clock), a redeemed ticket is spent, and
	 * expiry comes before approval because an expired ticket cannot move.
	 */
	public static function state(array $ticket, int $now): string
	{
		if ($ticket['revokedAt'] !== null) {
			return 'revoked';
		}
		if ($ticket['redeemedAt'] !== null) {
			return 'redeemed';
		}
		if ($now >= $ticket['expiresAt']) {
			return 'expired';
		}
		if ($ticket['approvedAt'] !== null) {
			return 'approved';
		}

		return 'issued';
	}

	/** `42718093` → `4271 8093`, the shape the app displays and compares. */
	public static function formatCode(string $digits): string
	{
		$bare = preg_replace('/\D/', '', $digits) ?? '';
		if (strlen($bare) <= self::CODE_LENGTH / 2) {
			return $bare;
		}

		return substr($bare, 0, self::CODE_LENGTH / 2) . ' ' . substr($bare, self::CODE_LENGTH / 2, self::CODE_LENGTH);
	}

	/**
	 * Whatever was sent, as the eight digits it meant — or null.
	 *
	 * Spaces and dashes are dropped, because a code arrives from a keyboard and a
	 * person may have typed the space it is displayed with. Anything else is not
	 * a code: this server mints digits, and a code it did not mint cannot be
	 * normalised into one.
	 */
	public static function normalizeCode(mixed $raw): ?string
	{
		if (!is_string($raw)) {
			return null;
		}
		$bare = preg_replace('/[\s-]/', '', $raw) ?? '';
		if (strlen($bare) !== self::CODE_LENGTH || preg_match('/^[0-9]+$/', $bare) !== 1) {
			return null;
		}

		return $bare;
	}

	/** A new code from PHP's CSPRNG: `random_int` is one by contract. */
	private static function newCode(): string
	{
		$digits = '';
		while (strlen($digits) < self::CODE_LENGTH) {
			$digits .= (string) random_int(0, 9);
		}

		return self::formatCode($digits);
	}

	/** The hash a token is stored under. Null when it is not a token at all. */
	private static function hash(string $token): ?string
	{
		if (preg_match('/^' . self::TOKEN_PREFIX . '[0-9a-f]{' . (self::TOKEN_BYTES * 2) . '}$/', $token) !== 1) {
			return null;
		}

		return hash('sha256', $token);
	}

	/** A label that can be drawn: one line, bounded, never a control character. */
	private static function label(string $label): string
	{
		$clean = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $label) ?? '');
		if ($clean === '') {
			return 'Device';
		}
		if (strlen($clean) > self::MAX_LABEL_BYTES) {
			$clean = rtrim(substr($clean, 0, self::MAX_LABEL_BYTES));
		}

		return $clean;
	}

	private function now(): int
	{
		return (int) ($this->clock)();
	}

	/* ---------------------------------------------------------------------
	 * Tickets on disk
	 * ------------------------------------------------------------------ */

	/** The file a code lives in — hashed, so a directory listing is not a list of codes. */
	private function path(string $code): string
	{
		$bare = self::normalizeCode($code) ?? '';

		return $this->root . '/tickets/' . hash('sha256', $bare) . '.json';
	}

	/**
	 * Every ticket file, oldest name order ignored.
	 *
	 * @return list<string>
	 */
	private function tickets(): array
	{
		$dir = $this->root . '/tickets';
		$names = @scandir($dir);
		if (!is_array($names)) {
			return [];
		}
		$paths = [];
		foreach ($names as $name) {
			if ($name === '.' || $name === '..' || !str_ends_with($name, '.json')) {
				continue;
			}
			$paths[] = $dir . '/' . $name;
		}

		return $paths;
	}

	/**
	 * Runs one decision against a ticket under an exclusive lock.
	 *
	 * The whole point of the lock: two redeems of the same code arrive together,
	 * the first sets `redeemedAt` and writes it, and the second reads that and
	 * answers `used`. Without it both would see an approved ticket and both would
	 * be handed a token.
	 *
	 * @param callable(array): array $change
	 */
	private function withTicket(mixed $code, callable $change): array
	{
		$normalized = self::normalizeCode($code);
		if ($normalized === null) {
			return self::refusal('invalid_code');
		}
		$path = $this->path($normalized);
		if (!is_file($path)) {
			return self::refusal('wrong_code');
		}

		$handle = @fopen($path, 'c+');
		if ($handle === false) {
			return self::refusal('wrong_code');
		}

		try {
			if (!flock($handle, LOCK_EX)) {
				return self::refusal('wrong_code');
			}
			$ticket = self::ticket(stream_get_contents($handle) ?: '');
			if ($ticket === null) {
				return self::refusal('wrong_code');
			}

			$result = $change($ticket);
			if (($result['write'] ?? false) === true) {
				$json = self::encode($result['pairing'] ?? null);
				if ($json === null) {
					return self::refusal('wrong_code');
				}
				ftruncate($handle, 0);
				rewind($handle);
				fwrite($handle, $json);
				fflush($handle);
			}
			// `write` is the decision's instruction to this function, not part of
			// the answer the caller gets back.
			unset($result['write']);

			return $result;
		} finally {
			flock($handle, LOCK_UN);
			fclose($handle);
		}
	}

	/**
	 * One ticket, from its stored JSON — or null when the file is not one.
	 *
	 * Read through the same rules the writer used: a hand-edited or truncated
	 * file reads as "no such code" rather than as a ticket with a missing field.
	 */
	public static function ticket(mixed $raw): ?array
	{
		if (!is_string($raw) || $raw === '') {
			return null;
		}
		try {
			$decoded = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			return null;
		}
		if (!is_array($decoded)) {
			return null;
		}

		$code = self::normalizeCode($decoded['code'] ?? null);
		if ($code === null) {
			return null;
		}

		return [
			'code' => self::formatCode($code),
			'label' => self::label(is_string($decoded['label'] ?? null) ? $decoded['label'] : ''),
			'account' => is_string($decoded['account'] ?? null) && $decoded['account'] !== '' ? $decoded['account'] : null,
			'issuedAt' => self::integer($decoded['issuedAt'] ?? 0),
			'expiresAt' => self::integer($decoded['expiresAt'] ?? 0),
			'approvedAt' => self::nullableInteger($decoded['approvedAt'] ?? null),
			'redeemedAt' => self::nullableInteger($decoded['redeemedAt'] ?? null),
			'revokedAt' => self::nullableInteger($decoded['revokedAt'] ?? null),
		];
	}

	private static function integer(mixed $value): int
	{
		return is_int($value) ? max(0, $value) : (is_numeric($value) ? max(0, (int) $value) : 0);
	}

	private static function nullableInteger(mixed $value): ?int
	{
		return $value === null ? null : self::integer($value);
	}

	private static function refusal(string $reason): array
	{
		return ['ok' => false, 'reason' => $reason];
	}

	private static function encode(mixed $ticket): ?string
	{
		if (!is_array($ticket)) {
			return null;
		}
		$json = json_encode($ticket, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

		return is_string($json) ? $json : null;
	}

	/** Writes a ticket file, atomically enough: a temp file, then a rename. */
	private function write(string $path, array $ticket): bool
	{
		$dir = dirname($path);
		if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
			return false;
		}
		@chmod($dir, 0770);

		$json = self::encode($ticket);
		if ($json === null) {
			return false;
		}

		$tmp = $dir . '/.' . bin2hex(random_bytes(6)) . '.tmp';
		if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
			@unlink($tmp);

			return false;
		}
		@chmod($tmp, 0660);

		if (!@rename($tmp, $path)) {
			@unlink($tmp);

			return false;
		}

		return true;
	}

	/** Deletes tickets that have been dead for a while. Best effort, bounded. */
	private function prune(int $now): void
	{
		$cutoff = $now - self::CODE_TTL_SECONDS * 2;
		$removed = 0;
		foreach ($this->tickets() as $path) {
			if ($removed >= self::PRUNE_LIMIT) {
				return;
			}
			$mtime = @filemtime($path);
			if (is_int($mtime) && $mtime < $cutoff && @unlink($path)) {
				$removed++;
			}
		}
	}

	/* ---------------------------------------------------------------------
	 * Devices on disk
	 * ------------------------------------------------------------------ */

	/**
	 * Every device record, as stored.
	 *
	 * @return list<array{hash: string, account: string, label: string, pairedAt: int, lastUsedAt: int, expiresAt: int, revokedAt: ?int}>
	 */
	private function devices(): array
	{
		$raw = @file_get_contents($this->devicesPath());
		if (!is_string($raw) || $raw === '') {
			return [];
		}
		try {
			$decoded = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			return [];
		}
		if (!is_array($decoded) || !is_array($decoded['devices'] ?? null)) {
			return [];
		}

		$rows = [];
		foreach ($decoded['devices'] as $entry) {
			if (!is_array($entry) || !is_string($entry['hash'] ?? null) || preg_match('/^[0-9a-f]{64}$/', $entry['hash']) !== 1) {
				continue;
			}
			$account = $entry['account'] ?? null;
			if (!is_string($account) || $account === '') {
				continue;
			}
			$rows[] = [
				'hash' => $entry['hash'],
				'account' => $account,
				'label' => self::label(is_string($entry['label'] ?? null) ? $entry['label'] : ''),
				'pairedAt' => self::integer($entry['pairedAt'] ?? 0),
				'lastUsedAt' => self::integer($entry['lastUsedAt'] ?? 0),
				'expiresAt' => self::integer($entry['expiresAt'] ?? 0),
				'revokedAt' => self::nullableInteger($entry['revokedAt'] ?? null),
			];
		}

		return $rows;
	}

	private function addDevice(array $device): bool
	{
		$devices = $this->devices();
		// One record per token, and a ceiling so the file cannot grow without
		// bound on a server that hands a device out on every request.
		foreach ($devices as $index => $existing) {
			if ($existing['hash'] === $device['hash']) {
				$devices[$index] = $device;

				return $this->saveDevices($devices);
			}
		}
		if (count($devices) >= 512) {
			$devices = array_slice($devices, -511);
		}
		$devices[] = $device;

		return $this->saveDevices($devices);
	}

	/** @param list<array> $devices */
	private function saveDevices(array $devices): bool
	{
		$path = $this->devicesPath();
		$dir = dirname($path);
		if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
			return false;
		}
		@chmod($dir, 0770);

		$json = json_encode(['devices' => array_values($devices)], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if (!is_string($json)) {
			return false;
		}

		$tmp = $dir . '/.devices.' . bin2hex(random_bytes(6)) . '.tmp';
		if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
			@unlink($tmp);

			return false;
		}
		@chmod($tmp, 0660);

		if (!@rename($tmp, $path)) {
			@unlink($tmp);

			return false;
		}

		return true;
	}

	private function devicesPath(): string
	{
		return $this->root . '/devices.json';
	}
}
