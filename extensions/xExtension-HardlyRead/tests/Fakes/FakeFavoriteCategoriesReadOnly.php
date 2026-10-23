<?php
declare(strict_types=1);

/**
 * Favorite Categories as the adapter can read it: the store, the category
 * list, and the single-category name lookup the 404 check needs.
 *
 * The write methods live on FakeFavoriteCategories, so this class is also the
 * "extension older than the adapter" case: readable, not writable.
 */
class FakeFavoriteCategoriesReadOnly
{
	/**
	 * @param list<array<string, mixed>> $categories
	 */
	public function __construct(
		private FakeFavoritesStore $store = new FakeFavoritesStore(),
		private array $categories = [
			['id' => 3, 'name' => 'Comics'],
			['id' => 7, 'name' => 'Faves'],
			['id' => 9, 'name' => 'News'],
		],
	) {
	}

	public function store(): FakeFavoritesStore
	{
		return $this->store;
	}

	/**
	 * @return list<array<string, mixed>>
	 */
	public function categories(): array
	{
		return $this->categories;
	}

	public function categoryName(int $catId): ?string
	{
		foreach ($this->categories as $row) {
			if ((int) ($row['id'] ?? 0) === $catId) {
				return (string) ($row['name'] ?? '');
			}
		}

		return null;
	}
}
