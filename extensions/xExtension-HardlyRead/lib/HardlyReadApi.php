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
 * The two collaborators are:
 *
 *   authenticate(string $authorization): ?string   raw Authorization header → username, or null
 *   loadHiddenCategories(string $username): ?object username → Hidden Categories extension, or null
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

	/**
	 * @param callable(string): ?string $authenticate
	 * @param callable(string): ?object $loadHiddenCategories
	 */
	public function __construct(callable $authenticate, callable $loadHiddenCategories)
	{
		$this->authenticate = Closure::fromCallable($authenticate);
		$this->loadHiddenCategories = Closure::fromCallable($loadHiddenCategories);
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
