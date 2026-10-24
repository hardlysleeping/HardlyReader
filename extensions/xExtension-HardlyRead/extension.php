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
 * headers, output) plus the collaborators the router needs.
 *
 * An install that carries the optional people provider gets the `/v1/people`
 * routes; on one that does not, they are unknown routes. Where that provider
 * lives is lib/HardlyReadPeople.php's business, not this file's.
 *
 * Reached at /api/misc.php/Hardly%20Read/v1/... — misc.php keys extensions by
 * the metadata `name`, never the entrypoint.
 */
class HardlyReadExtension extends Minz_Extension
{
	/** Registry key of the state-owning extension: metadata `name`, not entrypoint. */
	private const HIDDEN_EXTENSION = 'Hidden Categories';

	/**
	 * Registry keys of the pin-keeping extension, newest first.
	 *
	 * The extension was renamed "Pinned Categories" in 1.4 and called "Favorite
	 * Categories" before that. FreshRSS keys enablement by the metadata name, so
	 * which key is live depends on the version installed — try both rather than
	 * pinning this app to one of them.
	 */
	private const FAVORITES_EXTENSIONS = ['Pinned Categories', 'Favorite Categories'];

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
				loadFavorites: fn (string $username): ?object => $this->loadAnyUserExtension($username, self::FAVORITES_EXTENSIONS),
				loadSidebarIndent: fn (string $username): ?object => $this->loadUserExtension($username, self::INDENT_EXTENSION),
				loadPositions: fn (string $username): array => $this->positions($username)->load(),
				savePositions: fn (string $username, array $document): bool => $this->positions($username)->save($document),
				loadPeople: fn (): ?object => $this->loadPeople(),
				loadPins: fn (string $username): ?object => $this->pins($username),
			);

			$this->respond($api->dispatch($method, $path, $this->authorizationHeader(), $body, $_GET));
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
	 * The sidebar arrangement for one user.
	 *
	 * Per user by construction: the directory contains the login, so two accounts
	 * on one server cannot read each other's order. A username that cannot be
	 * used as a path is refused here rather than inside the store, so a bad login
	 * reads as "no arrangement" instead of a fatal error.
	 */
	private function positions(string $username): HardlyReadPositionStore
	{
		return new HardlyReadPositionStore(HardlyReadPositionStore::dirForUser($username));
	}

	/**
	 * The category pin order: read from, and written to, FreshRSS's own
	 * category positions.
	 *
	 * Pins are core data, so there is no extension to delegate to — the
	 * position sits in the category's `attributes`, which the website's form
	 * writes and an import preserves. What is NOT here matters as much: this
	 * never touches the pin-keeping extension's snapshot table or its
	 * favourite flag, and never writes a feed's priority. A pin made here is
	 * one field on one category row.
	 */
	private function pins(string $username): ?object
	{
		require_once __DIR__ . '/lib/HardlyReadPins.php';

		if (!class_exists('FreshRSS_Factory')) {
			return null;
		}
		try {
			$dao = FreshRSS_Factory::createCategoryDao($username);
		} catch (Throwable $e) {
			// The pin order is a nice-to-have; the rest of /v1/state is not.
			// A database that cannot be reached reports as "no order" instead
			// of taking the app's first call down with a 500.
			Minz_Log::warning('HardlyRead API: pins unavailable: ' . $e->getMessage());

			return null;
		}

		return new HardlyReadPins(
			rows: fn (): array => $this->categoryPositions($dao),
			write: fn (int $catId, ?int $position): array => $this->writeCategoryPosition($dao, $catId, $position),
		);
	}

	/**
	 * Every category with the position it is pinned at.
	 *
	 * Feeds are deliberately not populated: a pin is a fact about the category
	 * row alone, and joining feeds for it would cost a second query for
	 * nothing.
	 *
	 * @return list<array{id: int, name: string, position: int|null}>
	 */
	private function categoryPositions(FreshRSS_CategoryDAO $dao): array
	{
		$rows = [];
		foreach ($dao->listCategories(false) as $category) {
			if (!$category instanceof FreshRSS_Category) {
				continue;
			}
			$rows[] = [
				'id' => (int) $category->id(),
				'name' => (string) $category->name(),
				// Through the same accessor core sorts with, so a value that
				// reads as unpinned to listSortedCategories() reads as
				// unpinned here too.
				'position' => $category->attributeInt('position'),
			];
		}

		return $rows;
	}

	/**
	 * Writes one category's position, the way the website's category form does.
	 *
	 * updateCategory() writes name, kind and attributes in one statement, so
	 * all three are passed: sending only attributes would blank the name.
	 *
	 * @return array{ok: bool, code?: string}
	 */
	private function writeCategoryPosition(FreshRSS_CategoryDAO $dao, int $catId, ?int $position): array
	{
		$category = $dao->searchById($catId);
		if (!$category instanceof FreshRSS_Category) {
			return ['ok' => false, 'code' => 'category_not_found'];
		}

		$category->_attribute('position', $position);
		$written = $dao->updateCategory($catId, [
			'name' => $category->name(),
			'kind' => $category->kind(),
			'attributes' => $category->attributes(),
		]);
		if ($written === false) {
			return ['ok' => false, 'code' => 'save_failed'];
		}

		// Confirm the value landed instead of trusting the row count:
		// updateCategory() silently skips a category whose name collides with a
		// tag, and reporting a change the server did not make is worse than
		// reporting a failure.
		$after = $dao->searchById($catId);
		if (!$after instanceof FreshRSS_Category || $after->attributeInt('position') !== $position) {
			return ['ok' => false, 'code' => 'save_failed'];
		}

		if (function_exists('invalidateHttpCache')) {
			invalidateHttpCache();
		}

		return ['ok' => true];
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
	 * The optional people provider, or null when this install has none.
	 *
	 * Loaded here rather than at file scope for the same reason the router is:
	 * a system extension's init() runs on every page.
	 */
	private function loadPeople(): ?object
	{
		require_once __DIR__ . '/lib/HardlyReadPeople.php';

		// Presence on the server is not the question the app asks: it asks
		// whether this account has the provider, so an account without it gets
		// no toggle and no routes rather than a button that cannot work.
		if (!HardlyReadPeople::enabledForCurrentUser()) {
			return null;
		}

		return HardlyReadPeople::create();
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
	private function loadAnyUserExtension(string $username, array $names): ?object
	{
		foreach ($names as $name) {
			$extension = $this->loadUserExtension($username, $name);
			if ($extension !== null) {
				return $extension;
			}
		}
		return null;
	}

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
