<?php
declare(strict_types=1);

require_once __DIR__ . '/HardlyReadApiResponse.php';

/**
 * Router for the HardlyRead v1 API.
 *
 * Deliberately pure PHP: no superglobals, no headers, no exit(), no session
 * writes, no FreshRSS classes. Everything that needs the server is injected as
 * a closure, so the whole contract — auth order, routing, validation and
 * status mapping — can be exercised without booting FreshRSS.
 *
 * The collaborators are:
 *
 *   authenticate(string $authorization): ?string   raw Authorization header → username, or null
 *   loadHiddenCategories(string $username): ?object username → Hidden Categories extension, or null
 *   loadFavorites(string $username): ?object       username → Favorite Categories extension, or null
 *   loadSidebarIndent(string $username): ?object   username → Sidebar Feed Indent extension, or null
 *
 * Order matters and is fixed: authenticate BEFORE routing, so an unauthenticated
 * caller cannot enumerate routes, and authenticate BEFORE anything reads
 * per-user state (the production collaborator calls initUser()).
 */
final class HardlyReadApi
{
	public const API_VERSION = 1;

	/** The only path segment between the extension name and the route. */
	private const API_SEGMENT = 'v1';

	/** Mirrors HiddenCategoriesStore::VIEWS. */
	private const VIEWS = ['hidden', 'revealed', 'only'];

	/** Mirrors FavoriteCategoriesStore::VIEWS. */
	private const FAVORITE_VIEWS = ['all', 'only', 'without'];

	/** Kept out of CONTRACT_MESSAGES: that map is keyed by error code. */
	private const FAVORITE_VIEW_MESSAGE = 'View must be one of: all, only, without.';

	/** Mapped so the wire contract does not leak collaborator wording. */
	private const CONTRACT_MESSAGES = [
		'category_not_found' => 'Category does not exist.',
		'convergence_failed' => 'Category state changed, but some feed visibility updates failed.',
		'invalid_category' => 'Category id must be a positive integer.',
		'invalid_view' => 'View must be one of: hidden, revealed, only.',
		'locked' => 'Hidden Categories is locked: unlock it in FreshRSS first.',
	];

	private Closure $authenticate;

	private Closure $loadHiddenCategories;

	private Closure $loadFavorites;

	private Closure $loadSidebarIndent;

	/**
	 * @param callable(string): ?string $authenticate
	 * @param callable(string): ?object $loadHiddenCategories
	 * @param callable(string): ?object $loadFavorites
	 * @param callable(string): ?object $loadSidebarIndent
	 */
	public function __construct(
		callable $authenticate,
		callable $loadHiddenCategories,
		callable $loadFavorites,
		callable $loadSidebarIndent,
	) {
		$this->authenticate = Closure::fromCallable($authenticate);
		$this->loadHiddenCategories = Closure::fromCallable($loadHiddenCategories);
		$this->loadFavorites = Closure::fromCallable($loadFavorites);
		$this->loadSidebarIndent = Closure::fromCallable($loadSidebarIndent);
	}

	/**
	 * @param array<string, mixed> $body Already-decoded request body.
	 */
	public function dispatch(string $method, string $path, string $authorization = '', array $body = []): HardlyReadApiResponse
	{
		$username = ($this->authenticate)($authorization);
		if (!is_string($username) || $username === '') {
			// Same hint the GReader API sends, so a client can tell a bad
			// credential from a bad route.
			return self::error(401, 'unauthorized', 'A valid GoogleLogin credential is required.', [], ['Google-Bad-Token' => 'true']);
		}

		$segments = self::segments($path);
		if ($segments === []) {
			return self::error(404, 'route_not_found', 'No route was requested.');
		}
		if (array_shift($segments) !== self::API_SEGMENT) {
			return self::error(404, 'api_version_not_found', 'Unsupported API version.');
		}
		if ($segments === []) {
			return self::error(404, 'route_not_found', 'No route was requested.');
		}

		$method = strtoupper(trim($method));

		// GET /v1/state
		if ($segments[0] === 'state') {
			if (count($segments) !== 1) {
				return self::error(404, 'route_not_found', 'Unknown route.');
			}
			if ($method !== 'GET') {
				return self::methodNotAllowed('GET');
			}
			return new HardlyReadApiResponse(200, [
				'apiVersion' => self::API_VERSION,
				'hiddenCategories' => $this->hiddenState(($this->loadHiddenCategories)($username)),
				'favorites' => $this->favoritesState(($this->loadFavorites)($username)),
				'sidebarIndent' => $this->sidebarIndentState(($this->loadSidebarIndent)($username)),
			]);
		}

		// PUT /v1/hidden-categories/view
		// PUT /v1/view — accepted alias; `view` has to be matched before the
		// `{id}` pattern below or it would be read as a category id.
		$isViewRoute = ($segments[0] === 'view' && count($segments) === 1)
			|| ($segments[0] === 'hidden-categories' && count($segments) === 2 && $segments[1] === 'view');
		if ($isViewRoute) {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			return $this->changeView($username, $body);
		}

		// PUT /v1/hidden-categories/{id}
		if ($segments[0] === 'hidden-categories' && count($segments) === 2) {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			$rawId = $segments[1];
			// ctype_digit('0') is true, so a zero id needs its own rejection —
			// otherwise it reaches the store and comes back as a different error.
			if (!ctype_digit($rawId) || (int) $rawId <= 0) {
				return self::error(400, 'invalid_category', self::CONTRACT_MESSAGES['invalid_category']);
			}
			return $this->setCategoryHidden($username, (int) $rawId, $body);
		}

		// PUT /v1/favorites/view — matched before the {id} pattern below, for
		// the same reason the hidden-categories view route is.
		if ($segments[0] === 'favorites' && count($segments) === 2 && $segments[1] === 'view') {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			return $this->changeFavoritesView($username, $body);
		}

		// PUT /v1/favorites/{id}
		if ($segments[0] === 'favorites' && count($segments) === 2) {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			$rawId = $segments[1];
			if (!ctype_digit($rawId) || (int) $rawId <= 0) {
				return self::error(400, 'invalid_category', self::CONTRACT_MESSAGES['invalid_category']);
			}
			return $this->setCategoryFavorite($username, (int) $rawId, $body);
		}

		return self::error(404, 'route_not_found', 'Unknown route.');
	}

	/**
	 * Builds an error response in the frozen shape.
	 *
	 * @param array<string, mixed> $extra Extra top-level keys, e.g. hiddenCategories.
	 * @param array<string, string> $headers
	 */
	public static function error(int $status, string $code, string $message, array $extra = [], array $headers = []): HardlyReadApiResponse
	{
		$body = [
			'ok' => false,
			'error' => ['code' => $code, 'message' => $message],
		];
		foreach ($extra as $key => $value) {
			if (!array_key_exists($key, $body)) {
				$body[$key] = $value;
			}
		}
		return new HardlyReadApiResponse($status, $body, $headers);
	}

	private static function methodNotAllowed(string $allow): HardlyReadApiResponse
	{
		return self::error(405, 'method_not_allowed', 'Method not allowed for this route.', [], ['Allow' => $allow]);
	}

	/**
	 * @param array<string, mixed> $body
	 */
	private function setCategoryHidden(string $username, int $catId, array $body): HardlyReadApiResponse
	{
		// Explicit assignment, never a toggle: a missing or non-boolean value is
		// a malformed request, not a reason to guess.
		if (!array_key_exists('hidden', $body) || !is_bool($body['hidden'])) {
			return self::error(400, 'invalid_hidden_value', 'The "hidden" field must be a boolean.');
		}

		$hidden = ($this->loadHiddenCategories)($username);
		if (!$this->usable($hidden)) {
			return self::error(409, 'hidden_categories_unavailable', 'Hidden Categories is not enabled for this user.');
		}
		/** @var object $hidden */
		if (!method_exists($hidden, 'setCategoryHidden')) {
			// The adapter ships before Hidden Categories grows the method; that
			// is a documented incompatibility, not a 500.
			return self::error(409, 'extension_incompatible', 'Hidden Categories does not implement setCategoryHidden().');
		}

		$result = $hidden->setCategoryHidden($catId, $body['hidden']);
		return $this->mutationResponse(is_array($result) ? $result : [], $hidden);
	}

	/**
	 * @param array<string, mixed> $body
	 */
	private function changeView(string $username, array $body): HardlyReadApiResponse
	{
		$view = $body['view'] ?? null;
		if (!is_string($view) || !in_array($view, self::VIEWS, true)) {
			return self::error(400, 'invalid_view', self::CONTRACT_MESSAGES['invalid_view']);
		}

		$hidden = ($this->loadHiddenCategories)($username);
		if (!$this->usable($hidden)) {
			return self::error(409, 'hidden_categories_unavailable', 'Hidden Categories is not enabled for this user.');
		}
		/** @var object $hidden */
		$state = $this->hiddenState($hidden);

		// misc.php starts a volatile session, so the API never sees an unlocked
		// session. v1 refuses rather than bypassing the curtain, and still
		// reports the state so the client can explain itself.
		if (!empty($state['locked'])) {
			return self::error(423, 'locked', self::CONTRACT_MESSAGES['locked'], ['hiddenCategories' => $state]);
		}

		if (!method_exists($hidden, 'changeView')) {
			return self::error(409, 'extension_incompatible', 'Hidden Categories does not implement changeView().');
		}

		$result = $hidden->changeView($view);
		return $this->mutationResponse(is_array($result) ? $result : [], $hidden);
	}

	/**
	 * Favorite or unfavorite one category.
	 *
	 * Validation runs before the collaborator is touched, so a malformed
	 * request never reads per-user state.
	 *
	 * @param array<string, mixed> $body
	 */
	private function setCategoryFavorite(string $username, int $catId, array $body): HardlyReadApiResponse
	{
		// Explicit assignment, never a toggle.
		if (!array_key_exists('favorite', $body) || !is_bool($body['favorite'])) {
			return self::error(400, 'invalid_favorite_value', 'The "favorite" field must be a boolean.');
		}
		$favorite = $body['favorite'];

		$favorites = ($this->loadFavorites)($username);
		if (!$this->favoritesUsable($favorites)) {
			return self::error(409, 'favorites_unavailable', 'Favorite Categories is not enabled for this user.');
		}
		/** @var object $favorites */
		if (!method_exists($favorites, 'setCategoryFavorite')) {
			return self::error(409, 'extension_incompatible', 'Favorite Categories does not implement setCategoryFavorite().');
		}

		// Favorite Categories answers failures with a message, never a code,
		// and its own "not found" arrives after the call. Ask the category
		// list first so the 404 is a fact rather than a wording match. A
		// collaborator that cannot list categories returns null here and the
		// call decides.
		if ($this->favoriteCategoryExists($favorites, $catId) === false) {
			return self::error(404, 'category_not_found', self::CONTRACT_MESSAGES['category_not_found']);
		}

		$result = $favorites->setCategoryFavorite($catId, $favorite);
		$state = $this->favoritesState($favorites);

		return $this->favoritesMutationResponse(
			is_array($result) ? $result : [],
			$state,
			in_array($catId, $state['ids'] ?? [], true) === $favorite,
			true,
		);
	}

	/**
	 * Move the favorites view.
	 *
	 * No alias is offered for this route: `/v1/view` already belongs to
	 * Hidden Categories.
	 *
	 * @param array<string, mixed> $body
	 */
	private function changeFavoritesView(string $username, array $body): HardlyReadApiResponse
	{
		$view = $body['view'] ?? null;
		if (!is_string($view) || !in_array($view, self::FAVORITE_VIEWS, true)) {
			return self::error(400, 'invalid_view', self::FAVORITE_VIEW_MESSAGE);
		}

		$favorites = ($this->loadFavorites)($username);
		if (!$this->favoritesUsable($favorites)) {
			return self::error(409, 'favorites_unavailable', 'Favorite Categories is not enabled for this user.');
		}
		/** @var object $favorites */
		if (!method_exists($favorites, 'changeView')) {
			return self::error(409, 'extension_incompatible', 'Favorite Categories does not implement changeView().');
		}

		$result = $favorites->changeView($view);
		$state = $this->favoritesState($favorites);

		return $this->favoritesMutationResponse(
			is_array($result) ? $result : [],
			$state,
			($state['view'] ?? null) === $view,
			false,
		);
	}

	/**
	 * Maps a Favorite Categories operation result onto the wire contract.
	 *
	 * Favorite Categories reports two different things, and they have to be
	 * kept apart: `ok` (did the call do its job) and `converged` (did the
	 * feeds follow the saved state). A saved state with `converged === false`
	 * is the documented 409 — not a 200, and not a 500.
	 *
	 * $stateMatches is the caller's reading of the store after the call. It is
	 * what separates "saved, sweep failed" from "nothing was saved when the
	 * write failed": changeView() reports converged:false for both.
	 *
	 * The 200 body carries `changed` only where the contract names it — the
	 * category route does, the view route does not.
	 *
	 * @param array<string, mixed> $result
	 * @param array<string, mixed> $state
	 */
	private function favoritesMutationResponse(
		array $result,
		array $state,
		bool $stateMatches,
		bool $includeChanged,
	): HardlyReadApiResponse {
		$ok = (bool) ($result['ok'] ?? false);
		// A collaborator older than the `converged` field only reports ok.
		$converged = array_key_exists('converged', $result) ? (bool) $result['converged'] : $ok;

		// The extension reports a machine code on failure. Honour it before any
		// inference: a state store that cannot be opened is not a bad request,
		// and it is certainly not an internal error the client should retry.
		$code = is_string($result['code'] ?? null) ? $result['code'] : '';
		$message = is_string($result['message'] ?? null) && $result['message'] !== ''
			? $result['message']
			: 'Request failed.';
		switch ($code) {
			case '':
				break;
			case 'invalid_category':
				return self::error(400, 'invalid_category', $message);
			case 'invalid_view':
				return self::error(400, 'invalid_view', $message);
			case 'category_not_found':
				return self::error(404, 'category_not_found', $message);
			case 'store_unusable':
				return self::error(409, 'favorites_unavailable', $message, ['favorites' => $state]);
			case 'save_failed':
				return self::error(409, 'save_failed', $message, ['favorites' => $state]);
			case 'convergence_failed':
				return self::error(409, 'convergence_failed', $message, ['favorites' => $state]);
			default:
				// A code from a newer extension than this adapter knows: fall
				// through to the ok/converged reading rather than guessing.
				break;
		}

		if ($ok && $converged) {
			$body = ['ok' => true];
			if ($includeChanged) {
				$body['changed'] = (bool) ($result['changed'] ?? false);
			}
			$body['favorites'] = $state;
			return new HardlyReadApiResponse(200, $body);
		}

		if (!$converged && $stateMatches) {
			// Saved but not converged: the client reconciles from the state
			// instead of rolling back.
			return self::error(409, 'convergence_failed', self::CONTRACT_MESSAGES['convergence_failed'], ['favorites' => $state]);
		}

		// Store failure, or a collaborator that reports neither ok nor
		// convergence: the contract has no code for it.
		return self::error(500, 'internal_error', $message);
	}

	/**
	 * Does this category exist? null when the collaborator cannot tell.
	 */
	private function favoriteCategoryExists(object $favorites, int $catId): ?bool
	{
		if (method_exists($favorites, 'categoryName')) {
			$name = $favorites->categoryName($catId);

			return is_string($name) && $name !== '';
		}
		if (!method_exists($favorites, 'categories')) {
			return null;
		}
		foreach ((array) $favorites->categories() as $row) {
			if (is_array($row) && (int) ($row['id'] ?? 0) === $catId) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Maps a Hidden Categories operation result onto the wire contract.
	 *
	 * @param array<string, mixed> $result
	 */
	private function mutationResponse(array $result, object $hidden): HardlyReadApiResponse
	{
		$code = is_string($result['code'] ?? null) ? $result['code'] : '';
		$state = $this->hiddenState($hidden);

		if (!empty($result['ok'])) {
			$body = ['ok' => true];
			if (array_key_exists('changed', $result)) {
				$body['changed'] = (bool) $result['changed'];
			}
			$body['hiddenCategories'] = $state;
			return new HardlyReadApiResponse(200, $body);
		}

		$status = match ($code) {
			'invalid_category', 'invalid_view' => 400,
			'category_not_found' => 404,
			'convergence_failed' => 409,
			'locked' => 423,
			default => 500,
		};

		// Only documented codes reach the wire; anything else (store_error,
		// an empty result) is reported as internal_error with its detail kept
		// in the message, because the contract has no code for it.
		$documented = ['invalid_category', 'invalid_view', 'category_not_found', 'convergence_failed', 'locked'];
		$errorCode = in_array($code, $documented, true) ? $code : 'internal_error';
		$message = self::CONTRACT_MESSAGES[$code]
			?? (is_string($result['message'] ?? null) && $result['message'] !== '' ? $result['message'] : 'Request failed.');

		// convergence_failed carries the authoritative state so the client
		// reconciles instead of rolling back. locked carries it for the same
		// reason: the client's copy is what the user is looking at.
		$extra = in_array($code, ['convergence_failed', 'locked'], true) ? ['hiddenCategories' => $state] : [];

		return self::error($status, $errorCode, $message, $extra);
	}

	/**
	 * The machine-readable half of the state. Kept separate from the HTTP body
	 * so error responses can carry exactly the same block.
	 *
	 * @return array<string, mixed>
	 */
	private function hiddenState(?object $hidden): array
	{
		if (!$this->usable($hidden)) {
			// Not installed, not enabled for this user, or too old to read
			// state: the app falls back to device-local behaviour.
			return ['available' => false];
		}
		/** @var object $hidden */

		$store = $hidden->store();
		$hiddenIds = [];
		foreach ((array) $store->hiddenIds() as $id) {
			$id = (int) $id;
			if ($id > 0) {
				$hiddenIds[] = $id;
			}
		}

		// GReader only ever exposes category labels, never FreshRSS's numeric
		// category id, and the PUT route needs that id. This is the mapping.
		$categories = [];
		if (method_exists($hidden, 'categories')) {
			foreach ((array) $hidden->categories() as $row) {
				if (!is_array($row)) {
					continue;
				}
				$id = (int) ($row['id'] ?? 0);
				if ($id <= 0) {
					continue;
				}
				$categories[] = [
					'id' => $id,
					'name' => (string) ($row['name'] ?? ''),
					'hidden' => in_array($id, $hiddenIds, true),
				];
			}
		}

		return [
			'available' => true,
			'mode' => (string) $store->mode(),
			'view' => (string) $store->view(),
			'effectiveView' => (string) $hidden->effectiveView(),
			'hiddenIds' => $hiddenIds,
			'locked' => (bool) $store->isLocked(),
			'categories' => $categories,
		];
	}

	/**
	 * Can this object answer the read-only questions at all?
	 */
	private function usable(?object $hidden): bool
	{
		if (!is_object($hidden) || !method_exists($hidden, 'store') || !method_exists($hidden, 'effectiveView')) {
			return false;
		}
		return is_object($hidden->store());
	}

	/**
	 * The favorites block: what is stored, and which categories it names.
	 *
	 * `ids` is the stored truth; `categories` maps those ids to FreshRSS
	 * names, because GReader only ever exposes labels.
	 *
	 * @return array<string, mixed>
	 */
	private function favoritesState(?object $favorites): array
	{
		if (!$this->favoritesUsable($favorites)) {
			return ['available' => false];
		}
		/** @var object $favorites */

		$store = $favorites->store();
		$ids = [];
		foreach ((array) $store->favIds() as $id) {
			$id = (int) $id;
			if ($id > 0) {
				$ids[] = $id;
			}
		}

		$categories = [];
		if (method_exists($favorites, 'categories')) {
			foreach ((array) $favorites->categories() as $row) {
				if (!is_array($row)) {
					continue;
				}
				$id = (int) ($row['id'] ?? 0);
				if ($id <= 0) {
					continue;
				}
				$categories[] = [
					'id' => $id,
					'name' => (string) ($row['name'] ?? ''),
					'favorite' => in_array($id, $ids, true),
				];
			}
		}

		return [
			'available' => true,
			'view' => (string) $store->view(),
			'ids' => $ids,
			'categories' => $categories,
		];
	}

	private function favoritesUsable(?object $favorites): bool
	{
		if (!is_object($favorites) || !method_exists($favorites, 'store')) {
			return false;
		}
		$store = $favorites->store();

		return is_object($store) && method_exists($store, 'favIds') && method_exists($store, 'view');
	}

	/**
	 * The indent block. Read-only: Sidebar Feed Indent owns the value and its
	 * clamping, so nothing here re-clamps or writes it.
	 *
	 * @return array<string, mixed>
	 */
	private function sidebarIndentState(?object $indent): array
	{
		if (!is_object($indent) || !method_exists($indent, 'indent')) {
			return ['available' => false];
		}

		return ['available' => true, 'px' => (int) $indent->indent()];
	}

	/**
	 * @return list<string> Path segments, empty ones dropped.
	 */
	private static function segments(string $path): array
	{
		$segments = [];
		foreach (explode('/', rawurldecode($path)) as $segment) {
			if ($segment !== '') {
				$segments[] = $segment;
			}
		}
		return array_values($segments);
	}
}
