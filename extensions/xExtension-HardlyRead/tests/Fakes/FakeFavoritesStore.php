<?php
declare(strict_types=1);

/**
 * The read-only half of FavoriteCategoriesStore, as far as the adapter is
 * allowed to see it, plus the two mutators the fake extension needs to keep
 * the state honest between calls.
 */
final class FakeFavoritesStore
{
	/**
	 * @param list<int|string> $favIds
	 */
	public function __construct(
		private array $favIds = [],
		private string $view = 'all',
	) {
	}

	/**
	 * @return list<int|string>
	 */
	public function favIds(): array
	{
		return $this->favIds;
	}

	public function view(): string
	{
		return $this->view;
	}

	public function addFavorite(int $catId): void
	{
		if (!in_array($catId, $this->favIds, true)) {
			$this->favIds[] = $catId;
		}
	}

	public function removeFavorite(int $catId): void
	{
		$this->favIds = array_values(array_filter(
			$this->favIds,
			static fn (int|string $id): bool => (int) $id !== $catId,
		));
	}

	public function setView(string $view): void
	{
		$this->view = $view;
	}
}
