<?php
declare(strict_types=1);

/**
 * The read-only half of HiddenCategoriesStore, as far as the adapter is
 * allowed to see it.
 */
final class FakeHiddenCategoriesStore
{
	/**
	 * @param list<int|string> $hiddenIds
	 */
	public function __construct(
		private array $hiddenIds = [4, 12],
		private string $mode = 'strict',
		private string $view = 'hidden',
		private bool $locked = false,
	) {
	}

	/**
	 * @return list<int|string>
	 */
	public function hiddenIds(): array
	{
		return $this->hiddenIds;
	}

	public function mode(): string
	{
		return $this->mode;
	}

	public function view(): string
	{
		return $this->view;
	}

	public function isLocked(): bool
	{
		return $this->locked;
	}
}
