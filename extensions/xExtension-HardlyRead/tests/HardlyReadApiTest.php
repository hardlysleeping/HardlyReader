<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__) . '/lib/HardlyReadApi.php';

/**
 * Contract tests for the v1 router.
 *
 * Everything here runs against fakes: no FreshRSS, no database, no HTTP. The
 * point is to pin the wire contract (status, error code, message, headers and
 * body shape) plus the two things that are easy to regress silently:
 * authentication before routing, and the collaborator being called exactly
 * once, or not at all.
 */
final class HardlyReadApiTest extends TestCase
{
	private const AUTH = 'GoogleLogin auth=alice/test-token';

	/** @var list<string> */
	private array $loadedFor = [];

	/** @var list<string> */
	private array $favoritesLoadedFor = [];

	/** @var list<string> */
	private array $indentLoadedFor = [];

	/** @var list<string> */
	private array $pinsLoadedFor = [];

	protected function setUp(): void
	{
		$this->loadedFor = [];
		$this->favoritesLoadedFor = [];
		$this->indentLoadedFor = [];
		$this->pinsLoadedFor = [];
	}

	// ---------------------------------------------------------------- auth --

	public function testStateRequiresAuthentication(): void
	{
		$response = $this->api(new FakeHiddenCategories(), authenticated: false)
			->dispatch('GET', '/v1/state');

		self::assertSame(401, $response->status);
		self::assertSame('unauthorized', $response->body['error']['code']);
		self::assertSame(['Google-Bad-Token' => 'true'], $response->headers);
		self::assertSame([], $this->loadedFor, 'state must not be read before authentication');
	}

	public function testUnauthenticatedRequestCannotEnumerateRoutes(): void
	{
		// 401 has to win over routing, otherwise the status code tells an
		// anonymous caller which routes exist.
		$response = $this->api(new FakeHiddenCategories(), authenticated: false)
			->dispatch('GET', '/v1/nope');

		self::assertSame(401, $response->status);
		self::assertSame('unauthorized', $response->body['error']['code']);
	}

	public function testWrongCredentialIsRejected(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('GET', '/v1/state', 'GoogleLogin auth=alice/wrong-token');

		self::assertSame(401, $response->status);
		self::assertSame([], $this->loadedFor);
	}

	// --------------------------------------------------------------- state --

	public function testStateReportsHiddenCategoriesState(): void
	{
		$hidden = new FakeHiddenCategories(
			new FakeHiddenCategoriesStore(
				hiddenIds: [4, 12, 31],
				mode: 'strict',
				view: 'hidden',
				locked: false,
			),
			effectiveView: 'hidden',
		);

		$response = $this->api($hidden)->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertSame([], $response->headers);
		self::assertSame(
			[
				'apiVersion' => 1,
				'hiddenCategories' => [
					'available' => true,
					'mode' => 'strict',
					'view' => 'hidden',
					'effectiveView' => 'hidden',
					'hiddenIds' => [4, 12, 31],
					'locked' => false,
					'hasPasscode' => false,
					'categories' => [
						['id' => 4, 'name' => 'Comics', 'hidden' => true],
						['id' => 12, 'name' => 'News', 'hidden' => true],
						['id' => 31, 'name' => 'Art', 'hidden' => true],
					],
				],
				'favorites' => ['available' => false],
				'sidebarIndent' => ['available' => false],
				'peopleAvailable' => false,
				'pins' => ['available' => false],
			],
			$response->body,
		);
		self::assertSame(['alice'], $this->loadedFor);
	}

	public function testStateReportsRevealedViewAndLockedFlag(): void
	{
		$hidden = new FakeHiddenCategories(
			new FakeHiddenCategoriesStore(
				hiddenIds: [12],
				mode: 'light',
				view: 'revealed',
				locked: true,
			),
			effectiveView: 'revealed',
		);

		$state = $this->api($hidden)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['hiddenCategories'];

		self::assertSame('light', $state['mode']);
		self::assertSame('revealed', $state['view']);
		self::assertSame('revealed', $state['effectiveView']);
		self::assertSame([12], $state['hiddenIds']);
		self::assertTrue($state['locked']);
		self::assertSame(
			[
				['id' => 4, 'name' => 'Comics', 'hidden' => false],
				['id' => 12, 'name' => 'News', 'hidden' => true],
				['id' => 31, 'name' => 'Art', 'hidden' => false],
			],
			$state['categories'],
		);
	}

	public function testStateDropsNonPositiveHiddenIds(): void
	{
		$hidden = new FakeHiddenCategories(
			new FakeHiddenCategoriesStore(hiddenIds: [0, -3, 4, '7']),
		);

		$state = $this->api($hidden)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['hiddenCategories'];

		self::assertSame([4, 7], $state['hiddenIds']);
		self::assertTrue($state['categories'][0]['hidden']);
	}

	public function testStateOmitsCategoriesTheCollaboratorCannotList(): void
	{
		// A collaborator older than the categories() method: ids are still
		// known, the id/name mapping is not.
		$hidden = new class(new FakeHiddenCategoriesStore()) {
			public function __construct(private FakeHiddenCategoriesStore $store)
			{
			}

			public function store(): FakeHiddenCategoriesStore
			{
				return $this->store;
			}

			public function effectiveView(): string
			{
				return 'hidden';
			}
		};

		$state = $this->api($hidden)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['hiddenCategories'];

		self::assertSame([], $state['categories']);
		self::assertSame([4, 12], $state['hiddenIds']);
	}

	public function testStateWorksWithoutAnyExtension(): void
	{
		$response = $this->api(null)->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(200, $response->status);
		// Both new keys are present and unavailable rather than missing: the
		// client decides on `available`, never on a key being absent.
		self::assertSame(
			[
				'apiVersion' => 1,
				'hiddenCategories' => ['available' => false],
				'favorites' => ['available' => false],
				'sidebarIndent' => ['available' => false],
				'peopleAvailable' => false,
				'pins' => ['available' => false],
			],
			$response->body,
		);
	}

	public function testStateTreatsAnUnreadableCollaboratorAsUnavailable(): void
	{
		// Present, but without store()/effectiveView() — not something we can
		// read, so the app falls back to device-local behaviour.
		$stray = new class {
			public function effectiveView(): string
			{
				return 'hidden';
			}
		};

		$state = $this->api($stray)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['hiddenCategories'];

		self::assertSame(['available' => false], $state);
	}

	// ------------------------------------------------------------ category --

	public function testCanHideCategory(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['ok']);
		self::assertTrue($response->body['changed']);
		self::assertTrue($response->body['hiddenCategories']['available']);
		self::assertSame([12, true], $hidden->lastCategoryCall);
		self::assertSame(1, $hidden->categoryCalls);
	}

	public function testCanUnhideCategory(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->categoryResult = ['ok' => true, 'changed' => false, 'message' => 'Already visible.'];

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => false]);

		self::assertSame(200, $response->status);
		self::assertFalse($response->body['changed']);
		self::assertSame([12, false], $hidden->lastCategoryCall);
	}

	public function testZeroCategoryIdIsRejectedAsInvalid(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/0', self::AUTH, ['hidden' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame(0, $hidden->categoryCalls);
	}

	public function testNonNumericCategoryIdIsRejectedAsInvalid(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/abc', self::AUTH, ['hidden' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame(0, $hidden->categoryCalls);
	}

	/**
	 * @return array<string, array{string}>
	 */
	public static function malformedCategoryIds(): array
	{
		return [
			'negative' => ['-1'],
			'trailing letters' => ['12abc'],
			'decimal' => ['1.5'],
			'space padded' => ['12%20'],
		];
	}

	#[DataProvider('malformedCategoryIds')]
	public function testMalformedCategoryIdsAreRejected(string $segment): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/' . $segment, self::AUTH, ['hidden' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame(0, $hidden->categoryCalls);
	}

	/**
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function malformedHiddenValues(): array
	{
		return [
			'missing' => [[]],
			'string' => [['hidden' => 'true']],
			'int' => [['hidden' => 1]],
			'null' => [['hidden' => null]],
		];
	}

	/**
	 * @param array<string, mixed> $body
	 */
	#[DataProvider('malformedHiddenValues')]
	public function testCategoryWriteRequiresAnExplicitBoolean(array $body): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, $body);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_hidden_value', $response->body['error']['code']);
		self::assertSame(0, $hidden->categoryCalls);
	}

	public function testUnknownCategoryReturns404(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->categoryResult = [
			'ok' => false,
			'changed' => false,
			'code' => 'category_not_found',
			'message' => 'Category no longer exists.',
		];

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/999', self::AUTH, ['hidden' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('category_not_found', $response->body['error']['code']);
		self::assertSame('Category does not exist.', $response->body['error']['message']);
		self::assertFalse($response->body['ok']);
		self::assertArrayNotHasKey('hiddenCategories', $response->body);
	}

	public function testConvergenceFailureCarriesAuthoritativeState(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->categoryResult = [
			'ok' => false,
			'changed' => true,
			'code' => 'convergence_failed',
			'message' => 'Some feed visibility updates failed.',
		];

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('convergence_failed', $response->body['error']['code']);
		self::assertTrue($response->body['hiddenCategories']['available']);
		self::assertSame([4, 12], $response->body['hiddenCategories']['hiddenIds']);
	}

	public function testUndocumentedCollaboratorFailureIsReportedAsInternalError(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->categoryResult = [
			'ok' => false,
			'code' => 'store_error',
			'message' => 'Could not write the state database.',
		];

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(500, $response->status);
		self::assertSame('internal_error', $response->body['error']['code']);
		self::assertSame('Could not write the state database.', $response->body['error']['message']);
	}

	public function testCategoryWriteWithoutHiddenCategoriesReturns409(): void
	{
		$response = $this->api(null)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('hidden_categories_unavailable', $response->body['error']['code']);
	}

	public function testCategoryWriteAgainstAnOldHiddenCategoriesReturns409(): void
	{
		$hidden = new FakeHiddenCategoriesReadOnly();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('extension_incompatible', $response->body['error']['code']);
		self::assertStringContainsString('setCategoryHidden', $response->body['error']['message']);
	}

	public function testCategoryRoutesMatchOddSpellings(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('put', '//v1//hidden-categories/12/', self::AUTH, ['hidden' => true]);

		self::assertSame(200, $response->status);
		self::assertSame([12, true], $hidden->lastCategoryCall);
	}

	// ---------------------------------------------------------------- view --

	/**
	 * @return array<string, array{string, string}>
	 */
	public static function viewCases(): array
	{
		$cases = [];
		foreach (['/v1/view', '/v1/hidden-categories/view'] as $path) {
			foreach (['hidden', 'revealed', 'only'] as $view) {
				$cases[$path . ' ' . $view] = [$path, $view];
			}
		}

		return $cases;
	}

	#[DataProvider('viewCases')]
	public function testCanChangeView(string $path, string $view): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', $path, self::AUTH, ['view' => $view]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['ok']);
		self::assertTrue($response->body['hiddenCategories']['available']);
		self::assertSame($view, $hidden->lastViewCall);
		self::assertSame(1, $hidden->viewCalls);
	}

	/**
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function malformedViews(): array
	{
		return [
			'missing' => [[]],
			'unknown' => [['view' => 'everything']],
			'empty' => [['view' => '']],
			'not a string' => [['view' => 3]],
			'wrong case' => [['view' => 'Hidden']],
		];
	}

	/**
	 * @param array<string, mixed> $body
	 */
	#[DataProvider('malformedViews')]
	public function testUnknownViewIsRejectedBeforeAnyStateIsRead(array $body): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/view', self::AUTH, $body);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_view', $response->body['error']['code']);
		self::assertSame(0, $hidden->viewCalls);
		self::assertSame([], $this->loadedFor, 'validation must precede the collaborator read');
	}

	public function testViewChangeWithoutHiddenCategoriesReturns409(): void
	{
		$response = $this->api(null)
			->dispatch('PUT', '/v1/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('hidden_categories_unavailable', $response->body['error']['code']);
	}

	public function testViewChangeAgainstAnOldHiddenCategoriesReturns409(): void
	{
		$hidden = new FakeHiddenCategoriesReadOnly();

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('extension_incompatible', $response->body['error']['code']);
		self::assertStringContainsString('changeView', $response->body['error']['message']);
	}

	public function testViewChangeReturns423WhenLocked(): void
	{
		$hidden = new FakeHiddenCategories(
			new FakeHiddenCategoriesStore(view: 'hidden', locked: true),
		);

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/view', self::AUTH, ['view' => 'only']);

		self::assertSame(423, $response->status);
		self::assertSame('locked', $response->body['error']['code']);
		self::assertTrue($response->body['hiddenCategories']['locked']);
		self::assertSame(0, $hidden->viewCalls, 'a locked store must not be written to');
	}

	public function testViewConvergenceFailureCarriesAuthoritativeState(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->viewResult = [
			'ok' => false,
			'changed' => true,
			'code' => 'convergence_failed',
			'message' => 'Feed restoration failed.',
		];

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('convergence_failed', $response->body['error']['code']);
		self::assertArrayHasKey('hiddenCategories', $response->body);
	}

	public function testHiddenCategoriesStillAllowCategoryWritesWhileLocked(): void
	{
		// Deliberate asymmetry, mirroring HiddenCategories' own POST handler:
		// only the view switch is behind the PIN curtain.
		$hidden = new FakeHiddenCategories(
			new FakeHiddenCategoriesStore(locked: true),
		);

		$response = $this->api($hidden)
			->dispatch('PUT', '/v1/hidden-categories/12', self::AUTH, ['hidden' => true]);

		self::assertSame(200, $response->status);
		self::assertSame([12, true], $hidden->lastCategoryCall);
	}

	// ------------------------------------------------------------- favorites --

	public function testStateReportsFavoritesState(): void
	{
		$favorites = new FakeFavoriteCategories(new FakeFavoritesStore([3, 7], 'only'));

		$state = $this->api(null, favorites: $favorites)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['favorites'];

		self::assertSame(
			[
				'available' => true,
				'view' => 'only',
				'ids' => [3, 7],
				'categories' => [
					['id' => 3, 'name' => 'Comics', 'favorite' => true],
					['id' => 7, 'name' => 'Faves', 'favorite' => true],
					['id' => 9, 'name' => 'News', 'favorite' => false],
				],
			],
			$state,
		);
		self::assertSame(['alice'], $this->favoritesLoadedFor);
	}

	public function testStateDropsNonPositiveFavoriteIds(): void
	{
		$favorites = new FakeFavoriteCategories(new FakeFavoritesStore([0, -3, 3, '7']));

		$state = $this->api(null, favorites: $favorites)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['favorites'];

		self::assertSame([3, 7], $state['ids']);
		self::assertTrue($state['categories'][0]['favorite']);
		self::assertTrue($state['categories'][1]['favorite']);
	}

	public function testStateTreatsAnUnreadableFavoritesStoreAsUnavailable(): void
	{
		// store() is there, the two readers the adapter needs are not.
		$stray = new class {
			public function store(): object
			{
				return new class {
				};
			}
		};

		$state = $this->api(null, favorites: $stray)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['favorites'];

		self::assertSame(['available' => false], $state);
	}

	public function testFavoritesStateOmitsCategoriesTheCollaboratorCannotList(): void
	{
		// Readable store, no categories() — ids are still known.
		$favorites = new class(new FakeFavoritesStore([3])) {
			public function __construct(private FakeFavoritesStore $store)
			{
			}

			public function store(): FakeFavoritesStore
			{
				return $this->store;
			}
		};

		$state = $this->api(null, favorites: $favorites)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['favorites'];

		self::assertSame([], $state['categories']);
		self::assertSame([3], $state['ids']);
	}

	public function testCanFavoriteCategory(): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(200, $response->status);
		self::assertSame([], $response->headers);
		self::assertSame(
			[
				'ok' => true,
				'changed' => true,
				'favorites' => [
					'available' => true,
					'view' => 'all',
					'ids' => [3],
					'categories' => [
						['id' => 3, 'name' => 'Comics', 'favorite' => true],
						['id' => 7, 'name' => 'Faves', 'favorite' => false],
						['id' => 9, 'name' => 'News', 'favorite' => false],
					],
				],
			],
			$response->body,
		);
		self::assertSame([3, true], $favorites->lastFavoriteCall);
		self::assertSame(1, $favorites->favoriteCalls);
	}

	public function testRepeatingAFavoriteIsNotAChange(): void
	{
		$favorites = new FakeFavoriteCategories();
		$api = $this->api(null, favorites: $favorites);

		$first = $api->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);
		$second = $api->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertTrue($first->body['changed']);
		self::assertFalse($second->body['changed'], 'the store did not move, so changed must be false');
		self::assertSame([3], $second->body['favorites']['ids']);
	}

	public function testCanUnfavoriteCategory(): void
	{
		$favorites = new FakeFavoriteCategories(new FakeFavoritesStore([3, 7]));

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/7', self::AUTH, ['favorite' => false]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['changed']);
		self::assertSame([3], $response->body['favorites']['ids']);
		self::assertSame([7, false], $favorites->lastFavoriteCall);
	}

	public function testUnfavoritingSomethingThatWasNotAFavoriteIsNotAChange(): void
	{
		$favorites = new FakeFavoriteCategories(new FakeFavoritesStore([3]));

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/9', self::AUTH, ['favorite' => false]);

		self::assertSame(200, $response->status);
		self::assertFalse($response->body['changed']);
		self::assertSame([3], $response->body['favorites']['ids']);
	}

	public function testZeroFavoriteIdIsRejectedAsInvalid(): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/0', self::AUTH, ['favorite' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame(0, $favorites->favoriteCalls);
	}

	/**
	 * @return array<string, array{string}>
	 */
	public static function malformedFavoriteIds(): array
	{
		return [
			'negative' => ['-1'],
			'trailing letters' => ['12abc'],
			'decimal' => ['1.5'],
			'space padded' => ['12%20'],
		];
	}

	#[DataProvider('malformedFavoriteIds')]
	public function testMalformedFavoriteIdsAreRejected(string $segment): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/' . $segment, self::AUTH, ['favorite' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame(0, $favorites->favoriteCalls);
	}

	/**
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function malformedFavoriteValues(): array
	{
		return [
			'missing' => [[]],
			'string' => [['favorite' => 'true']],
			'int' => [['favorite' => 1]],
			'null' => [['favorite' => null]],
		];
	}

	/**
	 * @param array<string, mixed> $body
	 */
	#[DataProvider('malformedFavoriteValues')]
	public function testFavoriteWriteRequiresAnExplicitBoolean(array $body): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, $body);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_favorite_value', $response->body['error']['code']);
		self::assertSame(0, $favorites->favoriteCalls);
		self::assertSame([], $this->favoritesLoadedFor, 'validation must precede the collaborator read');
	}

	public function testUnknownFavoriteCategoryReturns404(): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/5', self::AUTH, ['favorite' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('category_not_found', $response->body['error']['code']);
		self::assertSame('Category does not exist.', $response->body['error']['message']);
		self::assertSame(0, $favorites->favoriteCalls, 'a missing category is never written to');
	}

	public function testFavoriteWriteWithoutFavoritesReturns409(): void
	{
		$response = $this->api(null)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('favorites_unavailable', $response->body['error']['code']);
	}

	public function testFavoriteWriteAgainstAnOldFavoritesReturns409(): void
	{
		$favorites = new FakeFavoriteCategoriesReadOnly();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('extension_incompatible', $response->body['error']['code']);
		self::assertStringContainsString('setCategoryFavorite', $response->body['error']['message']);
	}

	public function testFavoriteConvergenceFailureCarriesFavoritesState(): void
	{
		// Real shape: the store took the write, the feed sweep did not.
		$favorites = new FakeFavoriteCategories();
		$favorites->sweepFails = true;

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('convergence_failed', $response->body['error']['code']);
		self::assertTrue($response->body['favorites']['available']);
		self::assertSame([3], $response->body['favorites']['ids']);
	}

	public function testFavoriteStoreFailureIsAnInternalError(): void
	{
		// Nothing saved and no convergence: the contract has no code for this.
		$favorites = new FakeFavoriteCategories();
		$favorites->setResult = [
			'ok' => false,
			'changed' => false,
			'converged' => false,
			'catId' => 3,
			'favorite' => true,
			'message' => 'Could not write the state database.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(500, $response->status);
		self::assertSame('internal_error', $response->body['error']['code']);
		self::assertSame('Could not write the state database.', $response->body['error']['message']);
	}

	public function testFavoritesStoreUnusableCodeIsNotAnInternalError(): void
	{
		$favorites = new FakeFavoriteCategories();
		$favorites->setResult = [
			'ok' => false,
			'changed' => false,
			'converged' => false,
			'catId' => 3,
			'favorite' => true,
			'code' => 'store_unusable',
			'message' => 'Favorite Categories state store is unusable: the state directory is not writable.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('favorites_unavailable', $response->body['error']['code']);
		self::assertArrayHasKey('favorites', $response->body, 'the client reconciles from state');
	}

	public function testFavoritesSaveFailedCodeMapsTo409(): void
	{
		$favorites = new FakeFavoriteCategories();
		$favorites->setResult = [
			'ok' => false,
			'changed' => false,
			'converged' => false,
			'catId' => 3,
			'favorite' => true,
			'code' => 'save_failed',
			'message' => 'Could not save the favorite.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('save_failed', $response->body['error']['code']);
	}

	public function testFavoritesViewInvalidViewCodeIs400EvenWhenTheStateAgrees(): void
	{
		$favorites = new FakeFavoriteCategories();
		$favorites->viewResult = [
			'ok' => false,
			'changed' => false,
			'converged' => false,
			'view' => 'all',
			'code' => 'invalid_view',
			'message' => 'Unknown view "bogus": nothing was changed.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, ['view' => 'all']);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_view', $response->body['error']['code']);
	}

	public function testFavoritesConvergenceCodeKeepsTheStateItCarries(): void
	{
		$favorites = new FakeFavoriteCategories();
		$favorites->setResult = [
			'ok' => true,
			'changed' => true,
			'converged' => false,
			'catId' => 3,
			'favorite' => true,
			'code' => 'convergence_failed',
			'message' => 'Saved, but the feeds did not follow.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/3', self::AUTH, ['favorite' => true]);

		self::assertSame(409, $response->status);
		self::assertSame('convergence_failed', $response->body['error']['code']);
		self::assertArrayHasKey('favorites', $response->body);
	}

	public function testFavoriteRoutesRequireAuthentication(): void
	{
		$favorites = new FakeFavoriteCategories();
		$api = $this->api(null, authenticated: false, favorites: $favorites);

		foreach (['/v1/favorites/3', '/v1/favorites/view'] as $path) {
			$response = $api->dispatch('PUT', $path, '', ['favorite' => true, 'view' => 'only']);

			self::assertSame(401, $response->status, $path);
			self::assertSame('unauthorized', $response->body['error']['code'], $path);
		}
		self::assertSame([], $this->favoritesLoadedFor, 'no collaborator may be read before authentication');
	}

	public function testWrongMethodOnFavoriteCategoryReturns405WithAllowPut(): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('GET', '/v1/favorites/3', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('method_not_allowed', $response->body['error']['code']);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame(0, $favorites->favoriteCalls);
	}

	public function testFavoriteWriteRouteRejectsTrailingSegments(): void
	{
		$response = $this->api(null, favorites: new FakeFavoriteCategories())
			->dispatch('PUT', '/v1/favorites/3/extra', self::AUTH, ['favorite' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('route_not_found', $response->body['error']['code']);
	}

	// ------------------------------------------------------- favorites view --

	/**
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function favoriteViews(): array
	{
		return [
			'all' => [['view' => 'all']],
			'only' => [['view' => 'only']],
			'without' => [['view' => 'without']],
		];
	}

	/**
	 * @param array<string, mixed> $body
	 */
	#[DataProvider('favoriteViews')]
	public function testCanChangeFavoritesView(array $body): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, $body);

		self::assertSame(200, $response->status);
		self::assertSame(['ok' => true, 'favorites' => [
			'available' => true,
			'view' => $body['view'],
			'ids' => [],
			'categories' => [
				['id' => 3, 'name' => 'Comics', 'favorite' => false],
				['id' => 7, 'name' => 'Faves', 'favorite' => false],
				['id' => 9, 'name' => 'News', 'favorite' => false],
			],
		]], $response->body);
		self::assertSame($body['view'], $favorites->lastViewCall);
		self::assertSame(1, $favorites->viewCalls);
	}

	/**
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function malformedFavoriteViews(): array
	{
		return [
			'missing' => [[]],
			'hiding word' => [['view' => 'hidden']],
			'unknown' => [['view' => 'everything']],
			'empty' => [['view' => '']],
			'not a string' => [['view' => 3]],
			'wrong case' => [['view' => 'All']],
		];
	}

	/**
	 * @param array<string, mixed> $body
	 */
	#[DataProvider('malformedFavoriteViews')]
	public function testUnknownFavoritesViewIsRejectedBeforeAnyStateIsRead(array $body): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, $body);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_view', $response->body['error']['code']);
		self::assertSame(0, $favorites->viewCalls);
		self::assertSame([], $this->favoritesLoadedFor, 'validation must precede the collaborator read');
	}

	public function testFavoritesViewWithoutFavoritesReturns409(): void
	{
		$response = $this->api(null)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('favorites_unavailable', $response->body['error']['code']);
	}

	public function testFavoritesViewAgainstAnOldFavoritesReturns409(): void
	{
		$favorites = new FakeFavoriteCategoriesReadOnly();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('extension_incompatible', $response->body['error']['code']);
		self::assertStringContainsString('changeView', $response->body['error']['message']);
	}

	public function testFavoritesViewConvergenceFailureCarriesState(): void
	{
		// changeView() reports ok:false with converged:false, state saved.
		$favorites = new FakeFavoriteCategories();
		$favorites->viewSweepFails = true;

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, ['view' => 'only']);

		self::assertSame(409, $response->status);
		self::assertSame('convergence_failed', $response->body['error']['code']);
		self::assertSame('only', $response->body['favorites']['view']);
	}

	public function testFavoritesViewStoreFailureIsAnInternalError(): void
	{
		// Also ok:false with converged:false — but the store did not move, and
		// that is what tells the two failures apart.
		$favorites = new FakeFavoriteCategories();
		$favorites->viewResult = [
			'ok' => false,
			'changed' => false,
			'converged' => false,
			'view' => 'all',
			'message' => 'Could not save the view: nothing was changed.',
		];

		$response = $this->api(null, favorites: $favorites)
			->dispatch('PUT', '/v1/favorites/view', self::AUTH, ['view' => 'only']);

		self::assertSame(500, $response->status);
		self::assertSame('internal_error', $response->body['error']['code']);
		self::assertStringContainsString('Could not save the view', $response->body['error']['message']);
	}

	public function testWrongMethodOnFavoritesViewReturns405WithAllowPut(): void
	{
		$favorites = new FakeFavoriteCategories();

		$response = $this->api(null, favorites: $favorites)
			->dispatch('GET', '/v1/favorites/view', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame(0, $favorites->viewCalls);
	}

	// -------------------------------------------------------- sidebar indent --

	public function testStateReportsSidebarIndent(): void
	{
		$response = $this->api(null, sidebarIndent: new FakeSidebarIndent(28))
			->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertSame(['available' => true, 'px' => 28, 'max' => 60], $response->body['sidebarIndent']);
		self::assertSame(['alice'], $this->indentLoadedFor);
	}

	public function testIndentWriteStoresTheValueAndReportsIt(): void
	{
		$indent = new FakeSidebarIndent(12);

		$response = $this->api(null, sidebarIndent: $indent)
			->dispatch('PUT', '/v1/indent', self::AUTH, ['px' => 34]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['changed']);
		self::assertSame(34, $indent->indent());
		self::assertSame(1, $indent->writes);
		self::assertSame(['available' => true, 'px' => 34, 'max' => 60], $response->body['sidebarIndent']);
	}

	public function testIndentWriteIsClampedByTheExtension(): void
	{
		$indent = new FakeSidebarIndent(12);

		$response = $this->api(null, sidebarIndent: $indent)
			->dispatch('PUT', '/v1/indent', self::AUTH, ['px' => 90]);

		self::assertSame(200, $response->status);
		self::assertSame(60, $response->body['sidebarIndent']['px']);
	}

	public function testIndentWriteReportsNoChangeForTheSameValue(): void
	{
		$indent = new FakeSidebarIndent(34);

		$response = $this->api(null, sidebarIndent: $indent)
			->dispatch('PUT', '/v1/indent', self::AUTH, ['px' => 34]);

		self::assertSame(200, $response->status);
		self::assertFalse($response->body['changed']);
	}

	public function testIndentWriteNeedsAnInteger(): void
	{
		$indent = new FakeSidebarIndent(12);

		foreach ([['px' => '20'], ['px' => 2.5], []] as $body) {
			$response = $this->api(null, sidebarIndent: $indent)
				->dispatch('PUT', '/v1/indent', self::AUTH, $body);

			self::assertSame(400, $response->status);
			self::assertSame('invalid_indent', $response->body['error']['code']);
		}

		self::assertSame(0, $indent->writes);
	}

	public function testIndentWriteRefusesAnUnavailableExtension(): void
	{
		$response = $this->api(null)
			->dispatch('PUT', '/v1/indent', self::AUTH, ['px' => 20]);

		self::assertSame(409, $response->status);
		self::assertSame('indent_unavailable', $response->body['error']['code']);
	}

	public function testIndentRouteRejectsOtherMethods(): void
	{
		$indent = new FakeSidebarIndent(12);

		$response = $this->api(null, sidebarIndent: $indent)
			->dispatch('POST', '/v1/indent', self::AUTH, ['px' => 20]);

		self::assertSame(405, $response->status);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame(0, $indent->writes);
	}

	public function testStateTreatsAnUnreadableIndentAsUnavailable(): void
	{
		$stray = new class {
			public function px(): int
			{
				return 28;
			}
		};

		$state = $this->api(null, sidebarIndent: $stray)
			->dispatch('GET', '/v1/state', self::AUTH)
			->body['sidebarIndent'];

		self::assertSame(['available' => false], $state);
	}

	// ------------------------------------------------------------- routing --

	public function testUnknownRouteReturns404(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('GET', '/v1/nope', self::AUTH);

		self::assertSame(404, $response->status);
		self::assertSame('route_not_found', $response->body['error']['code']);
	}

	public function testUnknownApiVersionReturns404(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('GET', '/v2/state', self::AUTH);

		self::assertSame(404, $response->status);
		self::assertSame('api_version_not_found', $response->body['error']['code']);
	}

	public function testEmptyPathReturns404(): void
	{
		$response = $this->api(new FakeHiddenCategories())->dispatch('GET', '/', self::AUTH);

		self::assertSame(404, $response->status);
		self::assertSame('route_not_found', $response->body['error']['code']);
	}

	public function testTrailingSegmentsAreNotIgnored(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('GET', '/v1/state/extra', self::AUTH);

		self::assertSame(404, $response->status);
		self::assertSame('route_not_found', $response->body['error']['code']);
	}

	public function testWrongMethodOnStateReturns405WithAllowGet(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('PUT', '/v1/state', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('method_not_allowed', $response->body['error']['code']);
		self::assertSame('GET', $response->headers['Allow']);
	}

	public function testWrongMethodOnCategoryReturns405WithAllowPut(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('GET', '/v1/hidden-categories/12', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame(0, $hidden->categoryCalls);
	}

	public function testWrongMethodOnViewReturns405WithAllowPut(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('POST', '/v1/hidden-categories/view', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame(0, $hidden->viewCalls);
	}

	public function testCategoryWriteRouteRejectsTrailingSegments(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('PUT', '/v1/hidden-categories/12/extra', self::AUTH, ['hidden' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('route_not_found', $response->body['error']['code']);
	}

	// ------------------------------------------------------------- helpers --


	// ------------------------------------------------------- lock/unlock --

	public function testLockCallsTheExtensionOnce(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('POST', '/v1/lock', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['ok']);
		self::assertSame(1, $hidden->lockCalls);
		self::assertSame([4, 12], $response->body['hiddenCategories']['hiddenIds']);
	}

	public function testLockWithoutAPasscodeIsRefusedAndExplained(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->lockResult = ['ok' => false, 'message' => 'Set a passcode first.'];

		$response = $this->api($hidden)->dispatch('POST', '/v1/lock', self::AUTH);

		// 409, not 500: the request was valid, the instance is not ready.
		self::assertSame(409, $response->status);
		self::assertSame('passcode_required', $response->body['error']['code']);
		self::assertSame(1, $hidden->lockCalls);
	}

	public function testUnlockPassesThePasscodeThroughUnchanged(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('POST', '/v1/unlock', self::AUTH, ['passcode' => '001234']);

		self::assertSame(200, $response->status);
		self::assertSame(['001234'], $hidden->unlockArguments, 'leading zeroes must survive');
	}

	public function testWrongPasscodeIsForbiddenAndCarriesTheState(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->unlockResult = ['ok' => false, 'message' => 'Wrong passcode.'];

		$response = $this->api($hidden)->dispatch('POST', '/v1/unlock', self::AUTH, ['passcode' => '999']);

		// 403: authenticated, wrong code. 401 would make clients re-login.
		self::assertSame(403, $response->status);
		self::assertSame('wrong_passcode', $response->body['error']['code']);
		self::assertArrayHasKey('hiddenCategories', $response->body);
	}

	public function testUnlockWithoutAPasscodeFieldDoesNotReachTheExtension(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('POST', '/v1/unlock', self::AUTH, []);

		self::assertSame(400, $response->status);
		self::assertSame(0, $hidden->unlockCalls);
	}

	public function testPasscodeIsStoredThroughTheExtension(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('PUT', '/v1/passcode', self::AUTH, ['passcode' => '4321']);

		self::assertSame(200, $response->status);
		self::assertSame('4321', $hidden->lastPasscodeArgument);
	}

	public function testEmptyPasscodeClearsRatherThanFailing(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->passcodeResult = ['ok' => true, 'changed' => true, 'message' => 'Passcode cleared.'];

		$response = $this->api($hidden)->dispatch('PUT', '/v1/passcode', self::AUTH, ['passcode' => '']);

		self::assertSame(200, $response->status);
		self::assertSame('', $hidden->lastPasscodeArgument);
	}

	public function testRejectedPasscodeFormatIsABadRequest(): void
	{
		$hidden = new FakeHiddenCategories();
		$hidden->passcodeResult = ['ok' => false, 'message' => 'Passcode must be 1 to 6 digits, numbers only.'];

		$response = $this->api($hidden)->dispatch('PUT', '/v1/passcode', self::AUTH, ['passcode' => 'abcd']);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_passcode', $response->body['error']['code']);
	}

	public function testPasscodeFieldMustBeAString(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('PUT', '/v1/passcode', self::AUTH, ['passcode' => 1234]);

		self::assertSame(400, $response->status);
		self::assertSame(0, $hidden->passcodeCalls);
	}

	public function testLockRouteRejectsGet(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden)->dispatch('GET', '/v1/lock', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame(0, $hidden->lockCalls);
	}

	public function testLockRequiresAuthentication(): void
	{
		$hidden = new FakeHiddenCategories();

		$response = $this->api($hidden, authenticated: false)->dispatch('POST', '/v1/lock', self::AUTH);

		self::assertSame(401, $response->status);
		self::assertSame(0, $hidden->lockCalls);
	}

	public function testStateReportsWhetherALockIsPossible(): void
	{
		$withPasscode = new FakeHiddenCategories(new FakeHiddenCategoriesStore(passcode: '1234'));
		$without = new FakeHiddenCategories(new FakeHiddenCategoriesStore(passcode: ''));

		self::assertTrue(
			$this->api($withPasscode)->dispatch('GET', '/v1/state', self::AUTH)->body['hiddenCategories']['hasPasscode'],
			'the app needs to know a lock is possible before offering it',
		);
		self::assertFalse(
			$this->api($without)->dispatch('GET', '/v1/state', self::AUTH)->body['hiddenCategories']['hasPasscode'],
		);
	}

	private function api(
		?object $hidden,
		bool $authenticated = true,
		?object $favorites = null,
		?object $sidebarIndent = null,
		?object $pins = null,
	): HardlyReadApi {
		return new HardlyReadApi(
			authenticate: function (string $authorization) use ($authenticated): ?string {
				if (!$authenticated || $authorization !== self::AUTH) {
					return null;
				}

				return 'alice';
			},
			loadHiddenCategories: function (string $username) use ($hidden): ?object {
				$this->loadedFor[] = $username;

				return $hidden;
			},
			loadFavorites: function (string $username) use ($favorites): ?object {
				$this->favoritesLoadedFor[] = $username;

				return $favorites;
			},
			loadSidebarIndent: function (string $username) use ($sidebarIndent): ?object {
				$this->indentLoadedFor[] = $username;

				return $sidebarIndent;
			},
			loadPins: function (string $username) use ($pins): ?object {
				$this->pinsLoadedFor[] = $username;

				return $pins;
			},
		);
	}

	// ------------------------------------------------------------ revision --

	public function testRevisionIsStableWhileNothingChanges(): void
	{
		$hidden = new FakeHiddenCategories();
		$api = $this->api($hidden, favorites: new FakeFavoriteCategories());

		$first = $api->dispatch('GET', '/v1/revision', self::AUTH);
		$second = $api->dispatch('GET', '/v1/revision', self::AUTH);

		self::assertSame(200, $first->status);
		self::assertIsString($first->body['revision']);
		self::assertSame(40, strlen($first->body['revision']), 'a sha1, nothing longer');
		self::assertSame($first->body['revision'], $second->body['revision']);
	}

	public function testRevisionChangesWhenTheWebsiteHidesACategory(): void
	{
		// The website writes this state itself, without going through the API.
		// This is the case the token exists for.
		$store = new FakeHiddenCategoriesStore();
		$hidden = new FakeHiddenCategories($store);
		$api = $this->api($hidden);
		$before = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];

		// Written straight into the store, as the website's eye toggle does.
		$store->hide(4, true);

		$after = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];
		self::assertNotSame($before, $after);
	}

	public function testRevisionChangesWhenThePinnedViewChanges(): void
	{
		$favorites = new FakeFavoriteCategories();
		$api = $this->api(new FakeHiddenCategories(), favorites: $favorites);
		$before = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];

		$favorites->changeView('only');

		$after = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];
		self::assertNotSame($before, $after);
	}

	public function testRevisionChangesOnLock(): void
	{
		$store = new FakeHiddenCategoriesStore();
		$hidden = new FakeHiddenCategories($store);
		$api = $this->api($hidden);
		$before = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];

		$store->setLocked(true);

		self::assertNotSame($before, $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision']);
	}

	public function testRevisionWorksWithoutAnyExtension(): void
	{
		// No extensions installed is a state, not an error: the token answers so a
		// client can keep polling after an uninstall without special-casing it.
		$api = $this->api(null);
		$response = $api->dispatch('GET', '/v1/revision', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertIsString($response->body['revision']);
		self::assertSame(
			$response->body['revision'],
			$api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'],
		);
	}

	public function testRevisionRejectsOtherMethods(): void
	{
		$response = $this->api(new FakeHiddenCategories())->dispatch('PUT', '/v1/revision', self::AUTH);

		self::assertSame(405, $response->status);
		self::assertSame('method_not_allowed', $response->body['error']['code']);
	}

	public function testRevisionRequiresAuthentication(): void
	{
		$response = $this->api(new FakeHiddenCategories(), authenticated: false)
			->dispatch('GET', '/v1/revision');

		self::assertSame(401, $response->status);
		self::assertSame([], $this->loadedFor, 'no state is read for an anonymous caller');
	}

	public function testStateAndRevisionAgree(): void
	{
		// Same builders underneath: two requests that see the same state must
		// produce the same token, and the state route must not drift away from it.
		$store = new FakeHiddenCategoriesStore();
		$hidden = new FakeHiddenCategories($store);
		$api = $this->api($hidden, favorites: new FakeFavoriteCategories());

		$state = $api->dispatch('GET', '/v1/state', self::AUTH);
		$revision = $api->dispatch('GET', '/v1/revision', self::AUTH);

		$store->hide(2, true);

		$stateAfter = $api->dispatch('GET', '/v1/state', self::AUTH);
		$revisionAfter = $api->dispatch('GET', '/v1/revision', self::AUTH);

		self::assertSame($state->body['hiddenCategories']['view'], $stateAfter->body['hiddenCategories']['view']);
		self::assertNotSame($revision->body['revision'], $revisionAfter->body['revision']);
	}

	// ---------------------------------------------------------------- pins --

	public function testStateReportsPinnedCategoriesInPinOrder(): void
	{
		// 102 sits above 101 by position; 103 has none and 104 was only ordered
		// by hand in the web form (positive), so neither is a pin.
		// The order is the server's own (position ascending), never id order.
		$categories = new FakeCategoryPositions([101 => -999, 102 => -1000, 103 => null, 104 => 5]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertSame(['available' => true, 'categories' => [102, 101]], $response->body['pins']);
		self::assertSame(['alice'], $this->pinsLoadedFor);
	}

	public function testAHandSetOrderIsNotAPin(): void
	{
		// The web form's own category order starts at 1. A category dragged to
		// the top there is ordered, not pinned, and the sidebar extension does
		// not consider it a favourite — so it must not appear in this list.
		$categories = new FakeCategoryPositions([101 => 1, 102 => 2]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(['available' => true, 'categories' => []], $response->body['pins']);
	}

	public function testStateReportsPinsUnavailableWhenThereIsNoOrderToRead(): void
	{
		// A router built without the collaborator: the key is present and
		// false, so the client falls back to its own order instead of
		// treating a missing key as an old server.
		$response = $this->api(new FakeHiddenCategories())->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(['available' => false], $response->body['pins']);
	}

	public function testAnEmptyCategoryTableReadsAsAvailableAndEmpty(): void
	{
		$response = $this->api(new FakeHiddenCategories(), pins: (new FakeCategoryPositions())->pins())
			->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(['available' => true, 'categories' => []], $response->body['pins']);
	}

	public function testPinsBreakTiesByNameLikeCoreDoes(): void
	{
		// The web form allows two categories to share a position; core sorts
		// those by name, so this must agree or the app and the sidebar differ.
		$categories = new FakeCategoryPositions(
			[101 => HardlyReadPins::PIN_POSITION, 102 => HardlyReadPins::PIN_POSITION],
			[101 => 'Zebra', 102 => 'Alpha'],
		);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame([102, 101], $response->body['pins']['categories']);
	}

	public function testAPositionThatIsNotAnIntegerIsNotAPin(): void
	{
		// `position` lives in a JSON column, so a hand edit or an old import
		// can leave a string there. CategoryDAO::listSortedCategories() reads
		// it with attributeInt() and treats anything else as unpinned; so does
		// this, or the app would show a pin the server does not sort by.
		$pins = new HardlyReadPins(
			rows: fn (): array => [
				['id' => 101, 'name' => 'A', 'position' => '5'],
				['id' => 102, 'name' => 'B', 'position' => -1000],
			],
			write: fn (int $catId, ?int $position): array => ['ok' => true],
		);

		self::assertSame([102], $pins->pinnedIds());
	}

	public function testPinningACategoryPutsItAtTheTop(): void
	{
		// The pin lands on the same value the sidebar extension writes, so the
		// two can never disagree about how far up a pin belongs.
		$categories = new FakeCategoryPositions([101 => 5, 102 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/102', self::AUTH, ['pinned' => true]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['ok']);
		self::assertTrue($response->body['changed']);
		self::assertSame(['available' => true, 'categories' => [102]], $response->body['pins']);
		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(102));
		self::assertSame([['id' => 102, 'position' => HardlyReadPins::PIN_POSITION]], $categories->writes);
	}

	public function testAPinGoesBelowEveryHandSetPosition(): void
	{
		$categories = new FakeCategoryPositions([101 => null, 102 => 3]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(200, $response->status);
		self::assertSame([101], $response->body['pins']['categories']);
		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(101));
		self::assertLessThan(3, (int) $categories->positionOf(101));
	}

	public function testWithNothingPinnedTheFirstPinStartsAtTheBase(): void
	{
		$categories = new FakeCategoryPositions([101 => null, 102 => null]);

		$this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(101));
	}

	public function testEveryPinSharesOneValueAndSortsByName(): void
	{
		// The sidebar extension pins everything at one value and lets core's
		// name tie-break order them. Landing each pin a step higher would put
		// the app's pins above the site's and reorder them by press order —
		// a second opinion about the same field, which is the thing being
		// avoided here.
		$categories = new FakeCategoryPositions([101 => null, 102 => null, 103 => null]);
		$api = $this->api(new FakeHiddenCategories(), pins: $categories->pins());

		$api->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);
		$api->dispatch('PUT', '/v1/pins/category/102', self::AUTH, ['pinned' => true]);
		$third = $api->dispatch('PUT', '/v1/pins/category/103', self::AUTH, ['pinned' => true]);

		self::assertSame([101, 102, 103], $third->body['pins']['categories'], 'name order, like the site');
		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(101));
		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(102));
		self::assertSame(HardlyReadPins::PIN_POSITION, $categories->positionOf(103));
	}

	public function testPinningSomethingAlreadyPinnedIsNotAChange(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$first = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);
		$second = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertTrue($first->body['changed']);
		self::assertSame(200, $second->status);
		self::assertFalse($second->body['changed'], 'a repeat is not a change');
		self::assertSame(
			HardlyReadPins::PIN_POSITION,
			$categories->positionOf(101),
			'its place is kept, not re-ranked to the top',
		);
		self::assertSame(
			[['id' => 101, 'position' => HardlyReadPins::PIN_POSITION]],
			$categories->writes,
			'nothing is written for the repeat',
		);
	}

	public function testUnpinningClearsThePosition(): void
	{
		$categories = new FakeCategoryPositions([101 => HardlyReadPins::PIN_POSITION, 102 => 5]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => false]);

		self::assertSame(200, $response->status);
		self::assertTrue($response->body['changed']);
		self::assertSame(['available' => true, 'categories' => []], $response->body['pins']);
		self::assertNull($categories->positionOf(101));
		self::assertSame(
			[['id' => 101, 'position' => null]],
			$categories->writes,
			'the attribute is cleared, not set to zero',
		);
	}

	public function testUnpinningSomethingThatWasNotPinnedIsNotAChange(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => false]);

		self::assertSame(200, $response->status);
		self::assertFalse($response->body['changed']);
		self::assertSame([], $categories->writes);
	}

	public function testPinningAnUnknownCategoryIsNotFound(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/999', self::AUTH, ['pinned' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('category_not_found', $response->body['error']['code']);
		self::assertArrayHasKey('pins', $response->body, 'the client reconciles from the state it gets back');
		self::assertSame([], $categories->writes);
	}

	#[DataProvider('malformedCategoryIds')]
	public function testMalformedPinIdsAreRejected(string $segment): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/' . $segment, self::AUTH, ['pinned' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame([], $categories->writes);
	}

	public function testAZeroPinIdIsRejectedBeforeAnythingIsRead(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/0', self::AUTH, ['pinned' => true]);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_category', $response->body['error']['code']);
		self::assertSame([], $categories->writes);
		self::assertSame([], $this->pinsLoadedFor, 'a malformed request never reaches per-user state');
	}

	public static function malformedPinnedValues(): array
	{
		return [
			'missing' => [[]],
			'string' => [['pinned' => 'true']],
			'int' => [['pinned' => 1]],
			'null' => [['pinned' => null]],
		];
	}

	#[DataProvider('malformedPinnedValues')]
	public function testPinWriteRequiresAnExplicitBoolean(array $body): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, $body);

		self::assertSame(400, $response->status);
		self::assertSame('invalid_pinned_value', $response->body['error']['code']);
		self::assertSame([], $categories->writes);
		self::assertSame([], $this->pinsLoadedFor);
	}

	public function testPinRouteRequiresAuthentication(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), authenticated: false, pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(401, $response->status);
		self::assertSame('unauthorized', $response->body['error']['code']);
		self::assertSame([], $categories->writes);
		self::assertSame([], $this->pinsLoadedFor);
	}

	#[DataProvider('wrongPinMethods')]
	public function testPinRouteRejectsOtherMethods(string $method): void
	{
		$categories = new FakeCategoryPositions([101 => null]);

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch($method, '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(405, $response->status);
		self::assertSame('method_not_allowed', $response->body['error']['code']);
		self::assertSame('PUT', $response->headers['Allow']);
		self::assertSame([], $categories->writes);
	}

	public static function wrongPinMethods(): array
	{
		return ['get' => ['GET'], 'post' => ['POST'], 'patch' => ['PATCH'], 'delete' => ['DELETE']];
	}

	public function testPinRoutesThatAreNotExactlyOneIdAre404(): void
	{
		// `/v1/pins` and `/v1/pins/category` name no category, and a fourth
		// segment is not this route: none of them may be read as an id.
		foreach (['/v1/pins', '/v1/pins/category', '/v1/pins/category/12/extra', '/v1/pins/12'] as $path) {
			$response = $this->api(new FakeHiddenCategories())
				->dispatch('PUT', $path, self::AUTH, ['pinned' => true]);

			self::assertSame(404, $response->status, $path);
			self::assertSame('route_not_found', $response->body['error']['code'], $path);
		}
	}

	public function testPinWriteWithoutTheCollaboratorIsUnavailable(): void
	{
		$response = $this->api(new FakeHiddenCategories())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(503, $response->status);
		self::assertSame('pins_unavailable', $response->body['error']['code']);
		self::assertSame(['available' => false], $response->body['pins']);
	}

	public function testACollaboratorThatCannotSaveIsAnInternalError(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);
		$categories->failWith = 'save_failed';

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(500, $response->status);
		self::assertSame('internal_error', $response->body['error']['code']);
		self::assertFalse($response->body['ok']);
	}

	public function testACollaboratorThatLosesTheRowReportsNotFound(): void
	{
		$categories = new FakeCategoryPositions([101 => null]);
		$categories->failWith = 'category_not_found';

		$response = $this->api(new FakeHiddenCategories(), pins: $categories->pins())
			->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertSame(404, $response->status);
		self::assertSame('category_not_found', $response->body['error']['code']);
	}

	public function testRevisionChangesWhenAPinChanges(): void
	{
		// The website writes the position itself, without going through this
		// API, so the token has to cover it — that is the case it exists for.
		$categories = new FakeCategoryPositions([101 => null]);
		$api = $this->api(new FakeHiddenCategories(), pins: $categories->pins());
		$before = $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision'];

		$api->dispatch('PUT', '/v1/pins/category/101', self::AUTH, ['pinned' => true]);

		self::assertNotSame($before, $api->dispatch('GET', '/v1/revision', self::AUTH)->body['revision']);
	}
}
