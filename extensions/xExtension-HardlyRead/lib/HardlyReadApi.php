<?php
declare(strict_types=1);

require_once __DIR__ . '/HardlyReadApiResponse.php';
require_once __DIR__ . '/HardlyReadPositionStore.php';
require_once __DIR__ . '/HardlyReadPins.php';

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
 *   loadPins(string $username): ?object            username → the category-position reader/writer, or null
 *   loadPeople(): ?object                          the optional people provider, or null when absent
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
		'locked' => 'Hidden Categories is locked: unlock it with the passcode.',
		'invalid_passcode' => 'Passcode must be 1 to 6 digits, numbers only.',
		'passcode_required' => 'Set a passcode before locking: there is nothing to lock with.',
		'wrong_passcode' => 'Wrong passcode.',
		'invalid_positions' => 'Positions must be lists of ids.',
		'positions_unavailable' => 'Position storage is not available on this server.',
		'stale_positions' => 'A newer arrangement is already stored: read it and try again.',
		'invalid_pinned_value' => 'The "pinned" field must be a boolean.',
		'pins_unavailable' => 'Category order is not available on this server.',
	];

	private Closure $authenticate;

	private Closure $loadHiddenCategories;

	private Closure $loadFavorites;

	private Closure $loadSidebarIndent;

	/** @var ?Closure(string): array{updatedAt: int, categories: string[], feeds: string[]} */
	private ?Closure $loadPositions = null;

	/** @var ?Closure(string, array{updatedAt: int, categories: string[], feeds: string[]}): bool */
	private ?Closure $savePositions = null;

	/**
	 * The pin order's reader and writer, or null when nothing was wired.
	 *
	 * Null is what a router built by an older extension.php looks like, and it
	 * is reported as `pins.available: false` rather than as an error.
	 */
	private ?Closure $loadPins = null;

	/**
	 * Null when no loader was supplied at all: an install without the provider
	 * and a router built before it existed then behave the same way.
	 */
	private ?Closure $loadPeople = null;

	/**
	 * @param callable(string): ?string $authenticate
	 * @param callable(string): ?object $loadHiddenCategories
	 * @param callable(string): ?object $loadFavorites
	 * @param callable(string): ?object $loadSidebarIndent
	 * @param (callable(): ?object)|null $loadPeople
	 * @param (callable(string): ?object)|null $loadPins
	 */
	public function __construct(
		callable $authenticate,
		callable $loadHiddenCategories,
		callable $loadFavorites,
		callable $loadSidebarIndent,
		?callable $loadPositions = null,
		?callable $savePositions = null,
		?callable $loadPeople = null,
		?callable $loadPins = null,
	) {
		$this->authenticate = Closure::fromCallable($authenticate);
		$this->loadHiddenCategories = Closure::fromCallable($loadHiddenCategories);
		$this->loadFavorites = Closure::fromCallable($loadFavorites);
		$this->loadSidebarIndent = Closure::fromCallable($loadSidebarIndent);
		$this->loadPositions = $loadPositions === null ? null : Closure::fromCallable($loadPositions);
		$this->savePositions = $savePositions === null ? null : Closure::fromCallable($savePositions);
		$this->loadPeople = $loadPeople === null ? null : Closure::fromCallable($loadPeople);
		$this->loadPins = $loadPins === null ? null : Closure::fromCallable($loadPins);
	}

	/**
	 * @param array<string, mixed> $body Already-decoded request body.
	 * @param array<string, mixed> $query Already-decoded query string.
	 */
	public function dispatch(string $method, string $path, string $authorization = '', array $body = [], array $query = []): HardlyReadApiResponse
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

		// GET /v1/revision — one short token over the user's extension state.
		//
		// The website's own buttons (hide a category, pin a category, change the
		// pinned view, lock) write this state directly, without going through
		// this API, so a client has no way to hear about them. Polling the whole
		// state to find out is wasteful; polling a token is not. Any write, from
		// either side, changes the answer; nothing else does.
		if ($segments[0] === 'revision') {
			if (count($segments) !== 1) {
				return self::error(404, 'route_not_found', 'Unknown route.');
			}
			if ($method !== 'GET') {
				return self::methodNotAllowed('GET');
			}
			return new HardlyReadApiResponse(200, ['revision' => $this->revisionToken($username)]);
		}

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
				// Additive: appended after the frozen keys. Absent reads as
				// false in the client, so an older adapter is not a failure.
				'peopleAvailable' => $this->people() !== null,
				// The pin order, read from the categories' own `position`
				// attribute. It has to be reported here: GReader's tag list
				// carries ids only, so this is the one place a client can see
				// which categories are pinned and in what order.
				'pins' => $this->pinsState($this->pins($username)),
			]);
		}

		// GET  /v1/people/status   — is the door there at all?
		// GET  /v1/people?q=       — search
		// POST /v1/people          — add one by name
		//
		// With no provider installed every one of these is a plain unknown
		// route: a 200 with an empty list would read as "no such person",
		// which is a different truth from "this install has no provider".
		if ($segments[0] === 'people') {
			$people = $this->people();
			$isStatus = count($segments) === 2 && $segments[1] === 'status';
			if ($people === null || (count($segments) !== 1 && !$isStatus)) {
				return self::error(404, 'route_not_found', 'Unknown route.');
			}

			if ($isStatus) {
				if ($method !== 'GET') {
					return self::methodNotAllowed('GET');
				}
				return new HardlyReadApiResponse(200, ['enabled' => true]);
			}

			if ($method === 'GET') {
				$text = $query['q'] ?? '';
				$result = $people->search(is_string($text) ? $text : '');
				$payload = ['enabled' => true, 'people' => self::peopleList($result['people'] ?? [])];
				// A message is always a failure the client can show; an
				// empty list on its own is a real answer.
				if (is_string($result['message'] ?? null) && $result['message'] !== '') {
					$payload['message'] = $result['message'];
				}
				return new HardlyReadApiResponse(200, $payload);
			}

			if ($method !== 'POST') {
				return self::methodNotAllowed('GET, POST');
			}
			$name = $body['name'] ?? null;
			if (!is_string($name) || trim($name) === '') {
				return self::error(400, 'invalid_name', 'The "name" field is required.');
			}
			$result = $people->add(trim($name));
			return new HardlyReadApiResponse(200, [
				'ok' => (bool) ($result['ok'] ?? false),
				'message' => is_string($result['message'] ?? null) && $result['message'] !== ''
					? $result['message']
					: 'The request was not accepted.',
			]);
		}

		// GET, PUT /v1/positions — the sidebar arrangement the user dragged.
		//
		// The two lists the client keeps (`categoryOrder`, `feedOrder`) live here
		// so every device sees the same arrangement. This is the one place the
		// extension owns state instead of forwarding intent: FreshRSS keeps no
		// folder position, so there is nothing to hand this to. The website does
		// not read it yet.
		if ($segments[0] === 'positions') {
			if (count($segments) !== 1) {
				return self::error(404, 'route_not_found', 'Unknown route.');
			}
			if ($method === 'GET') {
				return new HardlyReadApiResponse(200, $this->positionsState($username));
			}
			if ($method === 'PUT') {
				return $this->putPositions($username, $body);
			}
			return self::methodNotAllowed('GET, PUT');
		}

		// PUT /v1/pins/category/{id} — pin a category at the top, or unpin it.
		//
		// A pin is the category's own `position` attribute, the same field the
		// website's category form writes and ImportService preserves, so the
		// order the app shows is the order the server sorts by rather than a
		// second list only the app knows. `/v1/favorites/{id}` still decides
		// whether a category is marked; this decides where it sits, and is the
		// only way a client can put it at the top.
		if ($segments[0] === 'pins' && count($segments) === 3 && $segments[1] === 'category') {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			$rawId = $segments[2];
			// ctype_digit('0') is true, so a zero id needs its own rejection —
			// same rule as the hidden and favourites category routes.
			if (!ctype_digit($rawId) || (int) $rawId <= 0) {
				return self::error(400, 'invalid_category', self::CONTRACT_MESSAGES['invalid_category']);
			}
			return $this->putCategoryPin($username, (int) $rawId, $body);
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

		// PUT /v1/indent — the one setting Sidebar Feed Indent owns. The app's
		// slider and the extension's slider are the same stored integer, so the
		// website and the app read the same value rather than two lookalikes.
		if ($segments[0] === 'indent' && count($segments) === 1) {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			return $this->setIndent($username, $body);
		}

		// Lock, unlock and passcode. These are the extension's own curtain
		// controls: without them the app can see a lock but never operate it,
		// which makes the lock button decoration.
		//
		// Matched before any {id} pattern so `lock` is never read as an id.
		if ($segments[0] === 'lock' && count($segments) === 1) {
			if ($method !== 'POST') {
				return self::methodNotAllowed('POST');
			}
			return $this->lockHidden($username);
		}

		if ($segments[0] === 'unlock' && count($segments) === 1) {
			if ($method !== 'POST') {
				return self::methodNotAllowed('POST');
			}
			return $this->unlockHidden($username, $body);
		}

		if ($segments[0] === 'passcode' && count($segments) === 1) {
			if ($method !== 'PUT') {
				return self::methodNotAllowed('PUT');
			}
			return $this->setPasscode($username, $body);
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
	 * The stored arrangement, or the empty one when no store is wired.
	 *
	 * @return array<string, mixed>
	 */
	private function positionsState(string $username): array
	{
		$stored = $this->loadPositions === null ? null : ($this->loadPositions)($username);
		$stored = is_array($stored) ? HardlyReadPositionStore::sanitise($stored) : HardlyReadPositionStore::empty();

		return [
			'apiVersion' => self::API_VERSION,
			'updatedAt' => $stored['updatedAt'],
			'categories' => $stored['categories'],
			'feeds' => $stored['feeds'],
		];
	}

	/**
	 * Stores both lists as one document.
	 *
	 * Last write wins, decided by the client's `updatedAt`: a device that was
	 * offline for a day must not overwrite an arrangement made since. A stale
	 * write is refused with 409 and the stored timestamp, so the client can read
	 * the newer document instead of guessing what it missed.
	 *
	 * @param array<string, mixed> $body
	 */
	private function putPositions(string $username, array $body): HardlyReadApiResponse
	{
		if ($this->loadPositions === null || $this->savePositions === null) {
			return self::error(503, 'positions_unavailable', self::CONTRACT_MESSAGES['positions_unavailable']);
		}

		foreach (['categories', 'feeds'] as $key) {
			if (array_key_exists($key, $body) && !is_array($body[$key])) {
				return self::error(400, 'invalid_positions', self::CONTRACT_MESSAGES['invalid_positions']);
			}
		}

		$incoming = HardlyReadPositionStore::sanitise($body);
		if ($incoming['updatedAt'] === 0) {
			$incoming['updatedAt'] = (int) floor(microtime(true) * 1000);
		}

		$stored = ($this->loadPositions)($username);
		$stored = is_array($stored) ? HardlyReadPositionStore::sanitise($stored) : HardlyReadPositionStore::empty();
		if ($stored['updatedAt'] > $incoming['updatedAt']) {
			return self::error(
				409,
				'stale_positions',
				self::CONTRACT_MESSAGES['stale_positions'],
				[
					'updatedAt' => $stored['updatedAt'],
					'categories' => $stored['categories'],
					'feeds' => $stored['feeds'],
				],
			);
		}

		if (!($this->savePositions)($username, $incoming)) {
			return self::error(500, 'save_failed', 'Could not save the arrangement.');
		}

		return new HardlyReadApiResponse(200, [
			'apiVersion' => self::API_VERSION,
			'updatedAt' => $incoming['updatedAt'],
			'categories' => $incoming['categories'],
			'feeds' => $incoming['feeds'],
		]);
	}

	/**
	 * Pins a category at the top, or clears its position.
	 *
	 * The write is the one the website's own category form performs, and it is
	 * deliberately narrow: only the category's `position` attribute changes,
	 * through the model, so every other attribute survives. Nothing here goes
	 * near a feed's `priority` or another extension's store — visibility and
	 * the favourite mark belong to the extensions that own them.
	 *
	 * @param array<string, mixed> $body
	 */
	private function putCategoryPin(string $username, int $catId, array $body): HardlyReadApiResponse
	{
		// Explicit assignment, never a toggle.
		if (!array_key_exists('pinned', $body) || !is_bool($body['pinned'])) {
			return self::error(400, 'invalid_pinned_value', self::CONTRACT_MESSAGES['invalid_pinned_value']);
		}

		$pins = $this->pins($username);
		if (!$this->pinsUsable($pins)) {
			return self::error(
				503,
				'pins_unavailable',
				self::CONTRACT_MESSAGES['pins_unavailable'],
				['pins' => $this->pinsState($pins)],
			);
		}
		/** @var object $pins */
		$result = $pins->pin($catId, $body['pinned']);
		$result = is_array($result) ? $result : [];
		$state = $this->pinsState($pins);

		if (($result['ok'] ?? false) === true) {
			return new HardlyReadApiResponse(200, [
				'ok' => true,
				'changed' => (bool) ($result['changed'] ?? false),
				'pins' => $state,
			]);
		}

		$code = is_string($result['code'] ?? null) ? $result['code'] : '';
		$message = is_string($result['message'] ?? null) && $result['message'] !== ''
			? $result['message']
			: 'The pin was not saved.';

		return match ($code) {
			'invalid_category' => self::error(400, 'invalid_category', self::CONTRACT_MESSAGES['invalid_category'], ['pins' => $state]),
			'category_not_found' => self::error(404, 'category_not_found', self::CONTRACT_MESSAGES['category_not_found'], ['pins' => $state]),
			'pins_unavailable' => self::error(503, 'pins_unavailable', self::CONTRACT_MESSAGES['pins_unavailable'], ['pins' => $state]),
			default => self::error(500, 'internal_error', $message, ['pins' => $state]),
		};
	}

	/**
	 * The pin reader/writer for this user, or null when nothing is wired.
	 *
	 * Resolved per call, like every other collaborator, so a router built
	 * without one answers as an install without the capability does.
	 */
	private function pins(string $username): ?object
	{
		if ($this->loadPins === null) {
			return null;
		}
		$pins = ($this->loadPins)($username);

		return is_object($pins) ? $pins : null;
	}

	private function pinsUsable(?object $pins): bool
	{
		return is_object($pins) && method_exists($pins, 'snapshot') && method_exists($pins, 'pin');
	}

	/**
	 * The pin block: which categories are pinned, top first.
	 *
	 * `available: false` means this server cannot report an order at all —
	 * the app then keeps its own. An empty list is a real answer: nothing is
	 * pinned.
	 *
	 * @return array<string, mixed>
	 */
	private function pinsState(?object $pins): array
	{
		if (!$this->pinsUsable($pins)) {
			return ['available' => false];
		}
		/** @var object $pins */
		$snapshot = $pins->snapshot();
		$snapshot = is_array($snapshot) ? $snapshot : [];

		$ids = [];
		foreach ((array) ($snapshot['categories'] ?? []) as $id) {
			$id = (int) $id;
			if ($id > 0) {
				$ids[] = $id;
			}
		}

		return ['available' => true, 'categories' => $ids];
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
	 * Writes the sidebar indent.
	 *
	 * The integer is required and must be one: `0` is a real value (flush with
	 * the edge), so an absent field cannot be read as zero without silently
	 * resetting a setting. Out-of-range values are clamped by the extension,
	 * which owns the cap, and the clamped value is what comes back.
	 *
	 * @param array<string, mixed> $body
	 */
	private function setIndent(string $username, array $body): HardlyReadApiResponse
	{
		if (!array_key_exists('px', $body) || !is_int($body['px'])) {
			return self::error(400, 'invalid_indent', 'The "px" field must be an integer.');
		}

		$indent = ($this->loadSidebarIndent)($username);
		if (!is_object($indent) || !method_exists($indent, 'indent')) {
			return self::error(409, 'indent_unavailable', 'Sidebar Feed Indent is not enabled for this user.');
		}
		if (!method_exists($indent, 'setIndent')) {
			// Documented incompatibility, not a 500: the app ships first.
			return self::error(409, 'extension_incompatible', 'Sidebar Feed Indent does not implement setIndent().');
		}

		$before = (int) $indent->indent();
		$indent->setIndent($body['px']);
		$state = $this->sidebarIndentState($indent);

		return new HardlyReadApiResponse(200, [
			'ok' => true,
			'changed' => ($state['px'] ?? $before) !== $before,
			'sidebarIndent' => $state,
		]);
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
	 * Locks the curtain. Refuses when no passcode exists, because the extension
	 * would then have no way back in.
	 */
	/**
	 * The object that actually holds the curtain controls.
	 *
	 * Hidden Categories keeps lock(), unlock() and setPasscode() on its store,
	 * and not every build forwards them from the extension object handed to
	 * this API. Demanding one shape made the app answer "does not implement
	 * lock()" on a server that can lock perfectly well, so resolve to whichever
	 * object has the method.
	 */
	private function curtain(object $hidden, string $method): ?object
	{
		if (method_exists($hidden, $method)) {
			return $hidden;
		}
		if (method_exists($hidden, 'store')) {
			$store = $hidden->store();
			if (is_object($store) && method_exists($store, $method)) {
				return $store;
			}
		}
		return null;
	}

	private function lockHidden(string $username): HardlyReadApiResponse
	{
		$hidden = ($this->loadHiddenCategories)($username);
		if (!$this->usable($hidden)) {
			return self::error(409, 'hidden_categories_unavailable', 'Hidden Categories is not enabled for this user.');
		}
		/** @var object $hidden */
		$curtain = $this->curtain($hidden, 'lock');
		if ($curtain === null) {
			return self::error(409, 'extension_incompatible', 'Hidden Categories does not implement lock().');
		}

		$result = $curtain->lock();
		$result = is_array($result) ? $result : [];
		if (($result['ok'] ?? false) !== true) {
			return self::error(
				409,
				'passcode_required',
				self::CONTRACT_MESSAGES['passcode_required'],
				['hiddenCategories' => $this->hiddenState($hidden)],
			);
		}

		return $this->mutationResponse($result, $hidden);
	}

	/**
	 * Unlocks with the passcode. Unlocking is global: the extension stores the
	 * locked flag once, so unlocking here unlocks for every client, including
	 * the web UI.
	 *
	 * @param array<string, mixed> $body
	 */
	private function unlockHidden(string $username, array $body): HardlyReadApiResponse
	{
		$passcode = $body['passcode'] ?? null;
		if (!is_string($passcode) || $passcode === '') {
			return self::error(400, 'wrong_passcode', 'The "passcode" field is required.');
		}

		$hidden = ($this->loadHiddenCategories)($username);
		if (!$this->usable($hidden)) {
			return self::error(409, 'hidden_categories_unavailable', 'Hidden Categories is not enabled for this user.');
		}
		/** @var object $hidden */
		$curtain = $this->curtain($hidden, 'unlock');
		if ($curtain === null) {
			return self::error(409, 'extension_incompatible', 'Hidden Categories does not implement unlock().');
		}

		$result = $curtain->unlock($passcode);
		$result = is_array($result) ? $result : [];
		if (($result['ok'] ?? false) !== true) {
			// 403, not 401: the request is authenticated, the code was wrong.
			return self::error(
				403,
				'wrong_passcode',
				self::CONTRACT_MESSAGES['wrong_passcode'],
				['hiddenCategories' => $this->hiddenState($hidden)],
			);
		}

		return $this->mutationResponse($result, $hidden);
	}

	/**
	 * Sets or clears the passcode. An empty string disables the lock, matching
	 * the extension's settings form.
	 *
	 * @param array<string, mixed> $body
	 */
	private function setPasscode(string $username, array $body): HardlyReadApiResponse
	{
		if (!array_key_exists('passcode', $body) || !is_string($body['passcode'])) {
			return self::error(400, 'invalid_passcode', 'The "passcode" field must be a string.');
		}

		$hidden = ($this->loadHiddenCategories)($username);
		if (!$this->usable($hidden)) {
			return self::error(409, 'hidden_categories_unavailable', 'Hidden Categories is not enabled for this user.');
		}
		/** @var object $hidden */
		$curtain = $this->curtain($hidden, 'setPasscode');
		if ($curtain === null) {
			return self::error(409, 'extension_incompatible', 'Hidden Categories does not implement setPasscode().');
		}

		$result = $curtain->setPasscode($body['passcode']);
		$result = is_array($result) ? $result : [];
		if (($result['ok'] ?? false) !== true) {
			return self::error(
				400,
				'invalid_passcode',
				is_string($result['message'] ?? null) && $result['message'] !== ''
					? $result['message']
					: self::CONTRACT_MESSAGES['invalid_passcode'],
				['hiddenCategories' => $this->hiddenState($hidden)],
			);
		}

		return $this->mutationResponse($result, $hidden);
	}

	/**
	 * A stable token over everything `/v1/state` reports, plus the API version.
	 *
	 * Deliberately built from the same builders as the state route: if a field
	 * changes, the token changes, and no separate list of "things worth
	 * watching" has to be kept in step with the payload. The payloads carry no
	 * timestamps, so a token that differs means the state really differs.
	 */
	private function revisionToken(string $username): string
	{
		$payload = [
			'apiVersion' => self::API_VERSION,
			'hiddenCategories' => $this->hiddenState(($this->loadHiddenCategories)($username)),
			'favorites' => $this->favoritesState(($this->loadFavorites)($username)),
			'sidebarIndent' => $this->sidebarIndentState(($this->loadSidebarIndent)($username)),
			// Availability is not a per-user write, but it is part of what
			// /v1/state reports, so it belongs in the same hash.
			'peopleAvailable' => $this->people() !== null,
			// A pin written from the website (or restored by an import)
			// changes the order without going through this API, so the token
			// has to cover it too.
			'pins' => $this->pinsState($this->pins($username)),
		];
		$json = json_encode($payload);
		return sha1($json === false ? '' : $json);
	}

	/**
	 * The optional people provider, or null when this install has none.
	 *
	 * Resolved per call, like every other collaborator, so a router built
	 * without a loader answers exactly as an install without a provider does.
	 */
	private function people(): ?object
	{
		if ($this->loadPeople === null) {
			return null;
		}
		$people = ($this->loadPeople)();

		return is_object($people) ? $people : null;
	}

	/**
	 * Normalises the provider's answer to the wire shape: name and added only,
	 * so nothing else the provider knows can leak into the client.
	 *
	 * @return list<array{name: string, added: bool}>
	 */
	private static function peopleList(mixed $rows): array
	{
		$people = [];
		foreach (is_array($rows) ? $rows : [] as $row) {
			if (!is_array($row) || !is_string($row['name'] ?? null) || $row['name'] === '') {
				continue;
			}
			$people[] = ['name' => $row['name'], 'added' => (bool) ($row['added'] ?? false)];
		}

		return $people;
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
			// Whether a lock is even possible. The app offers locking only when
			// a passcode exists, instead of failing at the point of use.
			'hasPasscode' => method_exists($store, 'hasPasscode') ? (bool) $store->hasPasscode() : false,
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

		$state = ['available' => true, 'px' => (int) $indent->indent()];
		if (method_exists($indent, 'maxIndent')) {
			$state['max'] = (int) $indent->maxIndent();
		}

		return $state;
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
