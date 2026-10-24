<?php
declare(strict_types=1);

/**
 * Where a user's sidebar positions live.
 *
 * Two lists, exactly the two the client keeps: the order the categories were
 * dragged into, and the order the feeds were dragged into. Both are arrays of
 * ids (`user/-/label/Design`, `feed/123`), because a label can be renamed and
 * an id cannot.
 *
 * Why a file and not the user configuration: FreshRSS's actualize_script loads
 * a copy of the user config for the whole refresh and writes its whole
 * in-memory copy back when the refresh finishes, so anything another request
 * wrote to the config meanwhile is silently dropped. That was reproduced with a
 * key that survived ninety seconds and was then wiped by a finishing refresh.
 * A file in the user's own data directory is outside that object entirely, and
 * it is per user by construction — no cross-account leak is possible, because
 * the path contains the login.
 *
 * FreshRSS has no folder position of its own, so this store is the only place
 * the arrangement exists. The website does not read it yet; the app does.
 */
final class HardlyReadPositionStore
{
	/** Refuse a document bigger than this rather than filling the data disk. */
	public const MAX_BYTES = 524288;

	/** How many ids one list may hold. A feed id is ~12 bytes; this is generous. */
	public const MAX_ENTRIES = 5000;

	/** Longest single id accepted, so one malformed row cannot bloat the file. */
	public const MAX_ID_LENGTH = 200;

	private string $dir;

	public function __construct(string $dir)
	{
		$this->dir = rtrim($dir, '/');
	}

	/**
	 * The directory holding one user's HardlyRead state.
	 *
	 * The username comes from an authenticated request, but it is validated
	 * again here: this path is built by string concatenation, and a login with a
	 * slash or a dot-dot in it would otherwise write outside the data directory.
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

	/** The two lists, as they were last written. Never throws: a broken file reads as empty. */
	public function load(): array
	{
		$raw = @file_get_contents($this->file());
		if (!is_string($raw) || $raw === '' || strlen($raw) > self::MAX_BYTES) {
			return self::empty();
		}

		try {
			$decoded = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			return self::empty();
		}

		return self::sanitise($decoded);
	}

	/**
	 * Writes both lists in one atomic step: a reader never sees half a document,
	 * and a crash between two writes cannot leave the categories from one drag
	 * beside the feeds from another.
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

		$tmp = $this->dir . '/positions.json.' . bin2hex(random_bytes(6)) . '.tmp';
		if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
			@unlink($tmp);
			return false;
		}
		@chmod($tmp, 0660);

		// rename() is atomic within one filesystem, which is what makes a
		// concurrent reader either see the old document or the new one.
		if (!@rename($tmp, $this->file())) {
			@unlink($tmp);
			return false;
		}

		return true;
	}

	public function file(): string
	{
		return $this->dir . '/positions.json';
	}

	/** @return array{updatedAt: int, categories: string[], feeds: string[]} */
	public static function empty(): array
	{
		return ['updatedAt' => 0, 'categories' => [], 'feeds' => []];
	}

	/**
	 * Coerces anything into the stored shape.
	 *
	 * Shared with the router's own validation on purpose: what is written is
	 * always re-read through the same rules, so a hand-edited file cannot make
	 * the API answer with a shape the client does not expect.
	 */
	public static function sanitise(mixed $value): array
	{
		if (!is_array($value)) {
			return self::empty();
		}

		$updatedAt = $value['updatedAt'] ?? 0;
		$updatedAt = is_int($updatedAt) && $updatedAt > 0 ? $updatedAt : (is_string($updatedAt) && ctype_digit($updatedAt) ? (int) $updatedAt : 0);

		return [
			'updatedAt' => $updatedAt,
			'categories' => self::ids($value['categories'] ?? []),
			'feeds' => self::ids($value['feeds'] ?? []),
		];
	}

	/** @return string[] Deduped, in order, capped. */
	public static function ids(mixed $list): array
	{
		if (!is_array($list)) {
			return [];
		}

		$out = [];
		$seen = [];
		foreach ($list as $entry) {
			if (!is_string($entry)) {
				continue;
			}
			$entry = trim($entry);
			if ($entry === '' || strlen($entry) > self::MAX_ID_LENGTH || isset($seen[$entry])) {
				continue;
			}
			$seen[$entry] = true;
			$out[] = $entry;
			if (count($out) >= self::MAX_ENTRIES) {
				break;
			}
		}

		return $out;
	}
}
