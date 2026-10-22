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

	protected function setUp(): void
	{
		$this->loadedFor = [];
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
					'categories' => [
						['id' => 4, 'name' => 'Comics', 'hidden' => true],
						['id' => 12, 'name' => 'News', 'hidden' => true],
						['id' => 31, 'name' => 'Art', 'hidden' => true],
					],
				],
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

	public function testStateWorksWithoutHiddenCategories(): void
	{
		$response = $this->api(null)->dispatch('GET', '/v1/state', self::AUTH);

		self::assertSame(200, $response->status);
		self::assertSame(
			['apiVersion' => 1, 'hiddenCategories' => ['available' => false]],
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

	private function api(?object $hidden, bool $authenticated = true): HardlyReadApi
	{
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
		);
	}
}
