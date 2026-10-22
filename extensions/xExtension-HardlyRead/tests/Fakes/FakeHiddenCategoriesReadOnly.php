<?php
declare(strict_types=1);

/**
 * A Hidden Categories collaborator that can be read but not written to.
 *
 * This is the shape the adapter must cope with in the field: extensions
 * installed before the setCategoryHidden()/changeView() commit. The router
 * has to answer 409 extension_incompatible, not 500.
 */
class FakeHiddenCategoriesReadOnly
{
	/**
	 * @param list<array<string, mixed>> $categories
	 */
	public function __construct(
		private FakeHiddenCategoriesStore $store = new FakeHiddenCategoriesStore(),
		private string $effectiveView = 'hidden',
		private array $categories = [
			['id' => 4, 'name' => 'Comics'],
			['id' => 12, 'name' => 'News'],
			['id' => 31, 'name' => 'Art'],
		],
	) {
	}

	public function store(): FakeHiddenCategoriesStore
	{
		return $this->store;
	}

	public function effectiveView(): string
	{
		return $this->effectiveView;
	}

	/**
	 * @return list<array<string, mixed>>
	 */
	public function categories(): array
	{
		return $this->categories;
	}
}
