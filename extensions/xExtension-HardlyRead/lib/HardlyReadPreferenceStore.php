<?php
declare(strict_types=1);

/**
 * Where a user's remembered settings live.
 *
 * One document per account: a small map of client namespaces to
 * `{ updatedAt, value }`. The client owns the namespaces and what their fields
 * mean; this store owns only the envelope — a version, a stamp that orders two
 * documents, and values that can be handed back unchanged.
 *
 * A file in the user's own data directory, for the same reason the arrangement
 * store is one: FreshRSS's actualize_script writes back the whole in-memory
 * copy of the user configuration when a refresh finishes, silently dropping
 * anything another request wrote to it meanwhile. The path contains the login,
 * so two accounts on one server cannot read each other's copy.
 *
 * Deliberately ignorant of field names inside a value. An older server must
 * keep a newer client's settings intact rather than prune what it does not
 * understand, so a namespace this build has never heard of is stored and
 * returned as it arrived. What is *not* stored is anything that is not a
 * bounded JSON value: the route is authenticated, but a 16 KB body is a 16 KB
 * body and the data directory is not a scratch space.
 */
final class HardlyReadPreferenceStore
{
	/** The request body cap, and therefore the stored document cap. */
	public const MAX_BYTES = 16384;

	/** Namespaces one document may hold. The client uses four. */
	public const MAX_NAMESPACES = 16;

	/** One namespace value's encoded size. Reading and theme are under 1 KB. */
	public const MAX_VALUE_BYTES = 8192;

	/** How deep a value may nest. The client's values are flat. */
	public const MAX_DEPTH = 4;

	private string $dir;

	public function __construct(string $dir)
	{
		$this->dir = rtrim($dir, '/');
	}

	/**
	 * The directory holding one user's HardlyRead state.
	 *
	 * The username comes from an authenticated request and is validated again:
	 * the path is built by concatenation, so a login with a slash or a dot-dot
	 * would otherwise write outside the data directory.
	 */
	public static function dirForUser(string $username): string
	{
		if ($username === '' || preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/', $username) !== 1) {
			throw new InvalidArgumentException('Unusable username for a state directory.');
		}
		if (str_contains($username, '..')) {
			throw new InvalidArgumentException('Unusable username for a state directory.');
		}

		return DATA_PATH . '/users/' . $username . '/extensions/HardlyRead';
	}

	/** The stored document. Never throws: a broken or absent file reads as empty. */
	public function load(): array
	{
		$raw = @file_get_contents($this->file());
		if (!is_string($raw) || $raw === '' || strlen($raw) > self::MAX_BYTES) {
			return self::empty();
		}

		try {
			$decoded = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			return self::empty();
		}

		return self::sanitise($decoded);
	}

	/**
	 * Writes the whole document in one atomic step.
	 *
	 * A reader never sees half a document, and a crash between two writes cannot
	 * leave one namespace from one save beside another from a different one.
	 */
	public function save(array $document): bool
	{
		$clean = self::sanitise($document);
		$json = json_encode($clean, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if (!is_string($json) || strlen($json) > self::MAX_BYTES) {
			return false;
		}

		if (!is_dir($this->dir) && !@mkdir($this->dir, 0770, true) && !is_dir($this->dir)) {
			return false;
		}
		@chmod($this->dir, 0770);

		$tmp = $this->dir . '/preferences.json.' . bin2hex(random_bytes(6)) . '.tmp';
		if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
			@unlink($tmp);
			return false;
		}
		@chmod($tmp, 0660);

		if (!@rename($tmp, $this->file())) {
			@unlink($tmp);
			return false;
		}

		return true;
	}

	public function file(): string
	{
		return $this->dir . '/preferences.json';
	}

	/** @return array{apiVersion: int, updatedAt: int, entries: array<string, array{updatedAt: int, value: mixed}>} */
	public static function empty(): array
	{
		return ['apiVersion' => 1, 'updatedAt' => 0, 'entries' => []];
	}

	/**
	 * Coerces anything into the stored shape.
	 *
	 * Shared with the router on purpose: what is written is always re-read
	 * through the same rules, so a hand-edited file cannot make the API answer
	 * with a shape the client does not expect.
	 *
	 * The document's stamp is derived from the entries rather than trusted on
	 * its own. A document that claimed a stamp in the year 3000 while carrying
	 * last week's values would otherwise refuse every honest write forever.
	 */
	public static function sanitise(mixed $value): array
	{
		if (!is_array($value)) {
			return self::empty();
		}

		$entries = [];
		$newest = 0;
		$rawEntries = $value['entries'] ?? [];
		if (is_array($rawEntries)) {
			foreach ($rawEntries as $name => $entry) {
				if (count($entries) >= self::MAX_NAMESPACES) {
					break;
				}
				if (!is_string($name) || preg_match('/^[A-Za-z][A-Za-z0-9._-]{0,31}$/', $name) !== 1) {
					continue;
				}
				if (!is_array($entry)) {
					continue;
				}
				// A namespace value is a settings map; a bare string or number
				// is not something a client could apply on the other side.
				if (!is_array($entry['value'] ?? null)) {
					continue;
				}
				$stamp = self::stamp($entry['updatedAt'] ?? 0);
				if ($stamp <= 0) {
					continue;
				}
				$clean = self::plain($entry['value'] ?? null, 0);
				if ($clean['ok'] !== true) {
					continue;
				}
				$encoded = json_encode($clean['value'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
				if (!is_string($encoded) || strlen($encoded) > self::MAX_VALUE_BYTES) {
					continue;
				}
				$entries[$name] = ['updatedAt' => $stamp, 'value' => $clean['value']];
				if ($stamp > $newest) {
					$newest = $stamp;
				}
			}
		}

		return [
			'apiVersion' => 1,
			// Derived, never claimed: a document that said "year 3000" while
			// carrying last week's entries would otherwise refuse every honest
			// write after it, and the client would merge it into the same dead
			// stamp on every retry.
			'updatedAt' => $newest,
			'entries' => $entries,
		];
	}

	private static function stamp(mixed $value): int
	{
		if (is_int($value)) {
			return $value > 0 ? $value : 0;
		}
		if (is_string($value) && ctype_digit($value)) {
			$number = (int) $value;

			return $number > 0 ? $number : 0;
		}

		return 0;
	}

	/**
	 * A bounded JSON value, rebuilt from scratch.
	 *
	 * Lists and maps are copied key by key, so a poison key such as `__proto__`
	 * cannot reach a JavaScript client as an own property it might spread, and
	 * a PHP object cannot arrive where a value belongs. `ok` is explicit
	 * because `null` is itself a legitimate value.
	 *
	 * @return array{ok: bool, value: mixed}
	 */
	private static function plain(mixed $value, int $depth): array
	{
		if ($value === null || is_bool($value) || is_int($value)) {
			return ['ok' => true, 'value' => $value];
		}
		if (is_float($value)) {
			return ['ok' => is_finite($value), 'value' => $value];
		}
		if (is_string($value)) {
			return ['ok' => strlen($value) <= 512, 'value' => $value];
		}
		if ($depth >= self::MAX_DEPTH || !is_array($value)) {
			return ['ok' => false, 'value' => null];
		}

		$out = [];
		$count = 0;
		foreach ($value as $key => $entry) {
			if (++$count > 64) {
				return ['ok' => false, 'value' => null];
			}
			if (is_string($key)) {
				if ($key === '' || strlen($key) > 64 || in_array($key, ['__proto__', 'constructor', 'prototype'], true)) {
					continue;
				}
				$clean = self::plain($entry, $depth + 1);
				if ($clean['ok'] !== true) {
					continue;
				}
				$out[$key] = $clean['value'];
				continue;
			}
			if (!is_int($key)) {
				return ['ok' => false, 'value' => null];
			}
			$clean = self::plain($entry, $depth + 1);
			if ($clean['ok'] !== true) {
				return ['ok' => false, 'value' => null];
			}
			$out[] = $clean['value'];
		}

		return ['ok' => true, 'value' => $out];
	}
}
