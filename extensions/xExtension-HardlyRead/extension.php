<?php
declare(strict_types=1);

/**
 * Hardly Read
 *
 * API bridge between HardlyReader clients and FreshRSS extensions.
 *
 * This extension owns no state of its own. It authenticates the caller with the
 * same GoogleLogin credential the GReader API accepts, then forwards intent to
 * the extension that owns that state: Hidden Categories (hide/unhide, view),
 * Favorite Categories (favorite/unfavorite, view) and, read-only, Sidebar Feed
 * Indent. It never writes feed priority, never opens another extension's state
 * database and never reimplements its rules: HardlyReader asks for a result,
 * the owning extension decides how to reach it.
 *
 * Routing, validation and status mapping live in lib/HardlyReadApi.php, which
 * has no FreshRSS dependency. This file is only the transport (superglobals,
 * headers, output) plus the two collaborators the router needs.
 *
 * Reached at /api/misc.php/Hardly%20Read/v1/... — misc.php keys extensions by
 * the metadata `name`, never the entrypoint.
 */
class HardlyReadExtension extends Minz_Extension
{
	/** Registry key of the state-owning extension: metadata `name`, not entrypoint. */
	private const HIDDEN_EXTENSION = 'Hidden Categories';

	/** Registry key of the favorites extension. */
	private const FAVORITES_EXTENSION = 'Favorite Categories';

	/** Registry key of the read-only indent extension. */
	private const INDENT_EXTENSION = 'Sidebar Feed Indent';

	/** Request bodies above this are refused rather than parsed. */
	private const MAX_BODY_BYTES = 16384;

	public function init(): void
	{
		parent::init();
		$this->registerHook(Minz_HookType::ApiMisc, [$this, 'handleApi']);
	}

	/**
	 * ApiMisc entry point.
	 *
	 * misc.php has authenticated nobody and has no user context, so this is the
	 * only guard in front of a writer into a user's feed visibility. Every
	 * request is authenticated before it is even routed.
	 */
	public function handleApi(): void
	{
		// Loaded here rather than at file scope: this extension is a system
		// extension, so init() runs on every page and most of those never reach
		// the API.
		require_once __DIR__ . '/lib/HardlyReadApi.php';

		try {
			[$method, $path] = $this->requestRoute();

			$body = $this->readJsonBody();
			if ($body === null) {
				$this->respond(HardlyReadApi::error(400, 'invalid_json', 'The request body is not a JSON object.'));
			}

			$api = new HardlyReadApi(
				authenticate: fn (string $authorization): ?string => $this->authenticateGoogleLogin($authorization),
				loadHiddenCategories: fn (string $username): ?object => $this->loadHiddenCategories($username),
				loadFavorites: fn (string $username): ?object => $this->loadUserExtension($username, self::FAVORITES_EXTENSION),
				loadSidebarIndent: fn (string $username): ?object => $this->loadUserExtension($username, self::INDENT_EXTENSION),
			);

			$this->respond($api->dispatch($method, $path, $this->authorizationHeader(), $body));
		} catch (Throwable $e) {
			// Never let a fatal error reach the client as a blank 500 page.
			Minz_Log::warning('HardlyRead API: ' . $e->getMessage());
			$this->respond(HardlyReadApi::error(500, 'internal_error', 'Internal server error.'));
		}
	}

	/**
	 * @return array{0: string, 1: string} [HTTP method, path inside this extension]
	 */
	private function requestRoute(): array
	{
		$method = $_SERVER['REQUEST_METHOD'] ?? '';
		$pathInfo = $_SERVER['PATH_INFO'] ?? ($_SERVER['ORIG_PATH_INFO'] ?? '');
		if (!is_string($pathInfo)) {
			$pathInfo = '';
		}

		$segments = [];
		foreach (explode('/', rawurldecode($pathInfo)) as $segment) {
			if ($segment !== '') {
				$segments[] = $segment;
			}
		}

		// Drop this extension's own name, which misc.php keeps as the first
		// segment. getName() is the metadata `name` — the same key misc.php and
		// the extension manager use.
		if ($segments !== [] && $segments[0] === $this->getName()) {
			array_shift($segments);
		}

		return [is_string($method) ? $method : '', implode('/', $segments)];
	}

	/** The raw Authorization header, or '' when the client sent none. */
	private function authorizationHeader(): string
	{
		foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
			$value = $_SERVER[$key] ?? null;
			if (is_string($value) && $value !== '') {
				return $value;
			}
		}

		if (function_exists('getallheaders')) {
			foreach (getallheaders() as $name => $value) {
				if (strcasecmp((string) $name, 'Authorization') === 0 && is_string($value)) {
					return $value;
				}
			}
		}

		return '';
	}

	/**
	 * @return array<string, mixed>|null null when a body was sent but is not a JSON object
	 */
	private function readJsonBody(): ?array
	{
		$raw = file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES + 1);
		if (!is_string($raw) || trim($raw) === '') {
			return [];
		}
		if (strlen($raw) > self::MAX_BODY_BYTES) {
			return null;
		}

		try {
			$decoded = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			return null;
		}

		return is_array($decoded) ? $decoded : null;
	}

	/**
	 * GoogleLogin authentication, mirroring greader.php::authorizationToUser().
	 *
	 * Header form: "GoogleLogin auth=<user>/<sha1hex>", where the hash is
	 * sha1(salt . user . apiPasswordHash). One FreshRSS API credential therefore
	 * serves both the GReader API and this one; no second password exists.
	 *
	 * initUser() happens here, before any collaborator reads per-user state:
	 * mode(), view() and isLocked() are per-user and read the wrong (system)
	 * context — silently — if they are touched first.
	 */
	private function authenticateGoogleLogin(string $authorization): ?string
	{
		// Some SAPIs hand back "GoogleLogin_auth=..." because spaces in a
		// parameter name become underscores; accept both spellings.
		$normalised = str_replace('GoogleLogin_', 'GoogleLogin ', $authorization);
		if (preg_match('/^GoogleLogin\s+auth=(.+)$/i', trim($normalised), $matches) !== 1) {
			return null;
		}

		$parts = explode('/', trim($matches[1]), 2);
		if (count($parts) !== 2) {
			return null;
		}
		[$username, $token] = $parts;

		if ($username === '' || $token === '' || !FreshRSS_user_Controller::checkUsername($username)) {
			return null;
		}

		FreshRSS_Context::initUser($username);

		if (
			!FreshRSS_Context::hasUserConf()
			|| !FreshRSS_Context::hasSystemConf()
			|| !FreshRSS_Context::userConf()->enabled
		) {
			return null;
		}

		$passwordHash = (string) FreshRSS_Context::userConf()->apiPasswordHash;
		if ($passwordHash === '') {
			return null;
		}

		$expected = sha1(FreshRSS_Context::systemConf()->salt . $username . $passwordHash);

		return hash_equals($expected, $token) ? $username : null;
	}

	/**
	 * The Hidden Categories extension, but only when it is enabled for the
	 * user who just authenticated.
	 */
	private function loadHiddenCategories(string $username): ?object
	{
		return $this->loadUserExtension($username, self::HIDDEN_EXTENSION);
	}

	/**
	 * One user extension, by metadata display name, but only when it is
	 * enabled for the user who just authenticated.
	 *
	 * findExtension() loads extension code regardless of enablement, so the
	 * enabled check below is the access control, not a formality. enableByList()
	 * is what actually registers the extension for this request: misc.php
	 * enabled only Hardly Read.
	 *
	 * Nothing here assumes an extension is installed or enabled: an absent or
	 * disabled one returns null, which the router reports as `available: false`.
	 */
	private function loadUserExtension(string $username, string $name): ?object
	{
		if ($username === '' || !FreshRSS_Context::hasUserConf()) {
			return null;
		}

		$enabled = FreshRSS_Context::userConf()->extensions_enabled;
		if (!is_array($enabled) || empty($enabled[$name])) {
			return null;
		}

		Minz_ExtensionManager::enableByList([$name => true], 'user');

		$extension = Minz_ExtensionManager::findExtension($name);

		return $extension instanceof Minz_Extension ? $extension : null;
	}

	/** Sends the response and ends the request. */
	private function respond(HardlyReadApiResponse $response): never
	{
		if (!headers_sent()) {
			http_response_code($response->status);
			header('Content-Type: application/json; charset=utf-8');
			// This state must never be cached by a proxy.
			header('Cache-Control: no-store');
			header('X-Content-Type-Options: nosniff');
			foreach ($response->headers as $name => $value) {
				header($name . ': ' . $value);
			}
		}

		echo json_encode(
			$response->body,
			JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		);
		exit;
	}
}
