<?php
declare(strict_types=1);

/**
 * Optional people provider, absent on installs that do not have it.
 *
 * The constants below are the whole of what this file knows about where the
 * provider lives; everything else it does is protocol. Nothing here reads or
 * writes the provider's own files beyond loading its token.
 */
final class HardlyReadPeople
{
	/** Registry directory inside FreshRSS's extensions folder. */
	public const DIRECTORY = 'xExtension-CrossSite';

	/** The page that answers, served from FreshRSS's p/ directory. */
	public const PAGE = 'addfeeds.php';

	/** The token file inside the provider's directory. */
	public const TOKEN_FILE = 'token.php';

	/**
	 * Whether the signed-in account has this provider switched on.
	 *
	 * Two different questions, and both have to be yes: the files are on the
	 * server (presence), and this account has the provider enabled (this). Keeping
	 * only the first meant every account on the install was offered a search they
	 * could not use. The enabled list is per user, and the name it is keyed by is
	 * the provider's own display name, read from its metadata rather than spelled
	 * out anywhere else.
	 */
	public static function enabledForCurrentUser(): bool
	{
		if (!class_exists('FreshRSS_Context') || !method_exists('FreshRSS_Context', 'hasUserConf')) {
			return false;
		}
		if (!FreshRSS_Context::hasUserConf()) {
			return false;
		}
		$enabled = FreshRSS_Context::userConf()->extensions_enabled;
		if (!is_array($enabled)) {
			return false;
		}
		$name = self::displayName();
		if ($name === '') {
			return false;
		}

		return !empty($enabled[$name]);
	}

	/** The provider's display name, as its metadata declares it. */
	private static function displayName(): string
	{
		static $name = null;
		if ($name !== null) {
			return $name;
		}
		$name = '';
		$file = dirname(__DIR__, 3) . '/extensions/' . self::DIRECTORY . '/metadata.json';
		if (!is_file($file)) {
			return $name;
		}
		$raw = @file_get_contents($file);
		if (!is_string($raw)) {
			return $name;
		}
		$meta = json_decode($raw, true);
		if (is_array($meta) && is_string($meta['name'] ?? null)) {
			$name = trim($meta['name']);
		}

		return $name;
	}

	/** The constant that token file defines. */
	public const TOKEN_CONSTANT = 'CROSSSITE_ADD_TOKEN';

	/** Total budget for the provider round trip, in seconds. */
	private const TIMEOUT_SECONDS = 5;

	/** Mirrors the cap the provider's own list applies. */
	private const MAX_RESULTS = 60;

	private const MESSAGE_UNREACHABLE = 'The people service did not respond.';

	private const MESSAGE_UNREADABLE = 'The people service answered with something that could not be read.';

	private const MESSAGE_NO_TOKEN = 'The people service is not available.';

	private string $root;

	/** @var (callable(string, string): ?array)|null */
	private ?Closure $transport;

	/** Cached for the request: the token cannot change under one dispatch. */
	private ?string $token = null;

	/**
	 * @param (callable(string, string): array{status: int, body: string}|null)|null $transport
	 *        Injected transport, for tests: $what is 'list', 'subs' or 'add'.
	 */
	public function __construct(string $root, ?callable $transport = null)
	{
		$this->root = rtrim($root, '/');
		$this->transport = $transport !== null ? Closure::fromCallable($transport) : null;
	}

	/**
	 * The provider, when this install has one, or null when it does not.
	 *
	 * Presence is two files: the page and the token source. Nothing about
	 * enablement is consulted, because the page answers regardless of it.
	 *
	 * @param (callable(string, string): array{status: int, body: string}|null)|null $transport
	 */
	public static function create(?string $root = null, ?callable $transport = null): ?self
	{
		$root = $root !== null && $root !== '' ? rtrim($root, '/') : dirname(__DIR__, 3);
		if (!is_file($root . '/p/' . self::PAGE)) {
			return null;
		}
		if (!is_file($root . '/extensions/' . self::DIRECTORY . '/' . self::TOKEN_FILE)) {
			return null;
		}

		return new self($root, $transport);
	}

	/**
	 * Names matching a free-text query.
	 *
	 * A failure is never an empty list: every failure carries a message, so a
	 * client can tell "nothing matched" from "this did not work".
	 *
	 * @return array{people: list<array{name: string, added: bool}>, message?: string}
	 */
	public function search(string $query): array
	{
		$query = trim($query);
		if ($query === '') {
			return ['people' => []];
		}
		if ($this->token() === '') {
			return self::failure(self::MESSAGE_NO_TOKEN);
		}

		$list = $this->fetch('list');
		if ($list === null) {
			return self::failure(self::MESSAGE_UNREACHABLE);
		}
		$people = self::parseList((string) ($list['body'] ?? ''));
		if ($people === null) {
			return self::failure(self::MESSAGE_UNREADABLE);
		}

		// Without the subscribed list, "added" is unknowable, and a guess
		// would offer a person who is already followed as a new one.
		$subs = $this->fetch('subs');
		if ($subs === null) {
			return self::failure(self::MESSAGE_UNREACHABLE);
		}
		$known = self::parseSubs((string) ($subs['body'] ?? ''));
		if ($known === null) {
			return self::failure(self::MESSAGE_UNREADABLE);
		}

		return ['people' => self::rank($people, $known, $query)];
	}

	/**
	 * Asks the provider to add one name.
	 *
	 * A refusal is a normal answer, not an error: the provider explains itself
	 * in `message` and the client shows that.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public function add(string $name): array
	{
		$name = trim($name);
		if ($name === '') {
			return ['ok' => false, 'message' => 'A name is required.'];
		}
		if ($this->token() === '') {
			return ['ok' => false, 'message' => self::MESSAGE_NO_TOKEN];
		}

		$response = $this->fetch('add', $name);
		if ($response === null) {
			return ['ok' => false, 'message' => self::MESSAGE_UNREACHABLE];
		}

		$decoded = json_decode((string) ($response['body'] ?? ''), true);
		if (!is_array($decoded) || !array_key_exists('ok', $decoded)) {
			return ['ok' => false, 'message' => self::MESSAGE_UNREADABLE];
		}

		$ok = (bool) $decoded['ok'];
		$message = is_string($decoded['message'] ?? null) ? trim($decoded['message']) : '';
		if ($message === '') {
			$message = $ok ? 'Added.' : 'The request was refused.';
		}

		return ['ok' => $ok, 'message' => $message];
	}

	/**
	 * @return array{people: list<never>, message: string}
	 */
	private static function failure(string $message): array
	{
		return ['people' => [], 'message' => $message];
	}

	/**
	 * The shared token, resolved server-side and cached for the request.
	 *
	 * Empty means the provider cannot be used: its pages refuse every request
	 * without it, so this is reported as unavailable rather than retried.
	 */
	private function token(): string
	{
		if ($this->token !== null) {
			return $this->token;
		}
		$this->token = '';

		$file = $this->root . '/extensions/' . self::DIRECTORY . '/' . self::TOKEN_FILE;
		if (!is_file($file)) {
			return $this->token;
		}
		if (!defined(self::TOKEN_CONSTANT)) {
			// Its own scope: the file assigns variables of its own.
			self::loadTokenFile($file);
		}
		if (defined(self::TOKEN_CONSTANT)) {
			$value = constant(self::TOKEN_CONSTANT);
			if (is_string($value)) {
				$this->token = trim($value);
			}
		}

		return $this->token;
	}

	private static function loadTokenFile(string $file): void
	{
		require_once $file;
	}

	/**
	 * @return array{status: int, body: string}|null null on a transport failure
	 */
	private function fetch(string $what, string $name = ''): ?array
	{
		if ($this->transport !== null) {
			$result = ($this->transport)($what, $name);

			return self::normalise($result);
		}

		return $this->http($what, $name);
	}

	/**
	 * @return array{status: int, body: string}|null
	 */
	private static function normalise(mixed $result): ?array
	{
		if (!is_array($result) || !is_string($result['body'] ?? null)) {
			return null;
		}

		return ['status' => (int) ($result['status'] ?? 0), 'body' => $result['body']];
	}

	/**
	 * One request to the provider page, bounded by the class timeout.
	 *
	 * @return array{status: int, body: string}|null
	 */
	private function http(string $what, string $name): ?array
	{
		$query = match ($what) {
			'list' => 'names=1',
			'subs' => 'subs=1',
			default => '',
		};
		$payload = $what === 'add' ? ['k' => $this->token(), 'name' => $name] : null;

		$deadline = microtime(true) + self::TIMEOUT_SECONDS;
		foreach ($this->urls($query) as $url) {
			$left = (int) ceil($deadline - microtime(true));
			if ($left <= 0) {
				break;
			}
			$result = self::request($url, $payload, min($left, self::TIMEOUT_SECONDS));
			if ($result !== null) {
				return $result;
			}
		}

		return null;
	}

	/**
	 * Where the page can be reached from inside the server.
	 *
	 * The loopback form comes first: the page is served by this same web
	 * server, while the configured base URL may be a published address that is
	 * unreachable from inside a container.
	 *
	 * @return list<string>
	 */
	private function urls(string $query): array
	{
		$path = $this->pagePath();
		if ($query !== '') {
			$path .= '?' . $query . '&k=' . urlencode($this->token());
		}

		// The bare loopback first, and not the port the request arrived on. That
		// port is whatever the request came in on, which in a container is the
		// published one — nothing listens there, so asking :8081 answered
		// nothing and the search reported that the service did not respond.
		// The web server in here is on 80; the request's own port is only worth
		// trying when it is something else.
		$urls = ['http://127.0.0.1' . $path];
		$port = $_SERVER['SERVER_PORT'] ?? null;
		if (is_int($port) || (is_string($port) && ctype_digit($port))) {
			if ((int) $port !== 80) {
				$urls[] = 'http://127.0.0.1:' . (int) $port . $path;
			}
		}

		$base = $this->baseUrl();
		if ($base !== '') {
			$urls[] = $base . $path;
		}

		return $urls;
	}

	/**
	 * The page's path on this install.
	 *
	 * Taken from this request rather than assembled from a guess: the page
	 * lives beside `api/`, which is where the calling request already came
	 * from, so whatever prefix the install is served under is already in
	 * SCRIPT_NAME.
	 */
	private function pagePath(): string
	{
		$prefix = '';
		$script = $_SERVER['SCRIPT_NAME'] ?? '';
		if (is_string($script) && $script !== '') {
			$prefix = dirname(dirname(str_replace('\\', '/', $script)));
			if ($prefix === '/' || $prefix === '.' || $prefix === '\\') {
				$prefix = '';
			}
		}
		if ($prefix === '') {
			// No request context (a CLI run): fall back to the configured URL.
			$prefix = $this->basePath();
		}

		return rtrim($prefix, '/') . '/' . self::PAGE;
	}

	private function baseUrl(): string
	{
		if (!class_exists('FreshRSS_Context') || !method_exists('FreshRSS_Context', 'hasSystemConf')) {
			return '';
		}
		if (!FreshRSS_Context::hasSystemConf()) {
			return '';
		}
		try {
			$base = (string) FreshRSS_Context::systemConf()->base_url;
		} catch (Throwable $e) {
			return '';
		}

		return rtrim($base, '/');
	}

	/** The path part of the base URL, which the p/ directory sits under. */
	private function basePath(): string
	{
		$parts = parse_url($this->baseUrl());
		$path = is_array($parts) ? ($parts['path'] ?? '') : '';

		return is_string($path) ? rtrim($path, '/') : '';
	}

	/**
	 * @param array<string, mixed>|null $payload
	 * @return array{status: int, body: string}|null null when nothing answered
	 */
	private static function request(string $url, ?array $payload, int $timeout): ?array
	{
		if (function_exists('curl_init')) {
			$handle = curl_init($url);
			if ($handle === false) {
				return null;
			}
			$headers = ['Accept: application/json'];
			$options = [
				CURLOPT_RETURNTRANSFER => true,
				CURLOPT_TIMEOUT => $timeout,
				CURLOPT_CONNECTTIMEOUT => $timeout,
				CURLOPT_FOLLOWLOCATION => false,
			];
			if ($payload !== null) {
				$encoded = json_encode($payload);
				$options[CURLOPT_POST] = true;
				$options[CURLOPT_POSTFIELDS] = is_string($encoded) ? $encoded : '{}';
				$headers[] = 'Content-Type: application/json';
			}
			$options[CURLOPT_HTTPHEADER] = $headers;
			curl_setopt_array($handle, $options);
			$body = curl_exec($handle);
			$status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
			curl_close($handle);
			if (!is_string($body)) {
				return null;
			}

			return ['status' => $status, 'body' => $body];
		}

		// No curl: the stream wrapper, with the same budget.
		$http = [
			'method' => $payload === null ? 'GET' : 'POST',
			'timeout' => $timeout,
			'ignore_errors' => true,
			'header' => "Accept: application/json\r\n",
		];
		if ($payload !== null) {
			$encoded = json_encode($payload);
			$http['header'] .= "Content-Type: application/json\r\n";
			$http['content'] = is_string($encoded) ? $encoded : '{}';
		}
		$body = @file_get_contents($url, false, stream_context_create(['http' => $http]));
		if (!is_string($body)) {
			return null;
		}
		$status = 0;
		foreach ($http_response_header ?? [] as $line) {
			if (is_string($line) && preg_match('~^HTTP/\S+\s+(\d{3})~', $line, $matches) === 1) {
				$status = (int) $matches[1];
			}
		}

		return ['status' => $status, 'body' => $body];
	}

	/**
	 * The provider's list: one row per person, as name, slug, tick mask and an
	 * optional alias.
	 *
	 * @return list<array{name: string, slug: string, alias: string}>|null
	 */
	private static function parseList(string $body): ?array
	{
		$start = strpos($body, '[');
		$end = strrpos($body, ']');
		if ($start === false || $end === false || $end <= $start) {
			return null;
		}
		$decoded = json_decode(substr($body, $start, $end - $start + 1), true);
		if (!is_array($decoded)) {
			return null;
		}

		$people = [];
		foreach ($decoded as $row) {
			if (!is_array($row)) {
				continue;
			}
			$name = is_string($row[0] ?? null) ? trim($row[0]) : '';
			if ($name === '') {
				continue;
			}
			$people[] = [
				'name' => $name,
				'slug' => is_string($row[1] ?? null) ? $row[1] : '',
				'alias' => is_string($row[3] ?? null) ? trim($row[3]) : '',
			];
		}

		return $people;
	}

	/**
	 * The provider's view of what is already followed: slugs, and names as
	 * comparison keys.
	 *
	 * @return array{subs: array<string, true>, names: array<string, true>}|null
	 */
	private static function parseSubs(string $body): ?array
	{
		$decoded = json_decode($body, true);
		if (!is_array($decoded) || ($decoded['ok'] ?? false) !== true) {
			return null;
		}

		$subs = [];
		foreach ((array) ($decoded['subs'] ?? []) as $slug) {
			if (is_string($slug) && $slug !== '') {
				$subs[self::lower($slug)] = true;
			}
		}
		$names = [];
		foreach ((array) ($decoded['names'] ?? []) as $key) {
			if (is_string($key) && $key !== '') {
				$names[$key] = true;
			}
		}

		return ['subs' => $subs, 'names' => $names];
	}

	/**
	 * Ranks the list against a query the way the provider's own page does, and
	 * marks each row as already followed.
	 *
	 * @param list<array{name: string, slug: string, alias: string}> $people
	 * @param array{subs: array<string, true>, names: array<string, true>} $known
	 * @return list<array{name: string, added: bool}>
	 */
	private static function rank(array $people, array $known, string $query): array
	{
		$needle = self::norm($query);
		if ($needle === '') {
			return [];
		}

		$scored = [];
		foreach ($people as $index => $person) {
			$score = self::score($needle, $person['name']);
			if ($person['alias'] !== '') {
				$score = max($score, self::score($needle, $person['alias']) * 0.98);
			}
			if ($score > 0.0) {
				$scored[] = [$score, $index];
			}
		}
		// Stable in PHP 8: equal scores keep the provider's own order.
		usort($scored, static fn (array $a, array $b): int => $b[0] <=> $a[0]);

		$rows = [];
		$seen = [];
		foreach (array_slice($scored, 0, self::MAX_RESULTS) as [, $index]) {
			$person = $people[$index];
			$added = self::isAdded($person, $known);
			$key = self::keyOf($person['name']);
			if ($key !== '' && isset($seen[$key])) {
				// One person under two spellings: one row, greyed if either
				// spelling is already followed.
				if ($added) {
					$rows[$seen[$key]]['added'] = true;
				}
				continue;
			}
			$rows[] = ['name' => $person['name'], 'added' => $added];
			if ($key !== '') {
				$seen[$key] = count($rows) - 1;
			}
		}

		return array_values($rows);
	}

	/**
	 * @param array{name: string, slug: string, alias: string} $person
	 * @param array{subs: array<string, true>, names: array<string, true>} $known
	 */
	private static function isAdded(array $person, array $known): bool
	{
		$slug = self::lower($person['slug']);
		if ($slug !== '' && isset($known['subs'][$slug])) {
			return true;
		}
		$key = self::keyOf($person['name']);
		if ($key !== '' && isset($known['names'][$key])) {
			return true;
		}
		if ($person['alias'] !== '') {
			$alias = self::keyOf($person['alias']);
			if ($alias !== '' && isset($known['names'][$alias])) {
				return true;
			}
		}

		return false;
	}

	/**
	 * How well one name answers a query. Word prefixes score highest, a hit
	 * inside a word scores low, and a query word that matches nothing rejects
	 * the whole row.
	 */
	private static function score(string $query, string $haystack): float
	{
		$needles = array_values(array_filter(explode(' ', $query), static fn (string $word): bool => $word !== ''));
		if ($needles === []) {
			return 0.0;
		}

		$words = explode(' ', self::lower($haystack));
		$total = 0.0;
		foreach ($needles as $needle) {
			$best = 0.0;
			foreach ($words as $word) {
				if ($word === '') {
					continue;
				}
				$at = strpos($word, $needle);
				if ($at === 0) {
					$best = max($best, strlen($needle) / strlen($word) + 1.0);
				} elseif ($at !== false) {
					$best = max($best, 0.4);
				}
			}
			if ($best <= 0.0) {
				return 0.0;
			}
			$total += $best;
		}

		return $total / count($needles);
	}

	/** Lowercase, punctuation folded to single spaces. */
	private static function norm(string $text): string
	{
		$folded = preg_replace('/[^a-z0-9]+/', ' ', self::lower($text));

		return trim(is_string($folded) ? $folded : '');
	}

	/** The comparison key: lowercase letters and digits only. */
	private static function keyOf(string $text): string
	{
		$key = preg_replace('/[^a-z0-9]+/', '', self::norm($text));

		return is_string($key) ? $key : '';
	}

	private static function lower(string $text): string
	{
		return function_exists('mb_strtolower') ? mb_strtolower($text, 'UTF-8') : strtolower($text);
	}
}
