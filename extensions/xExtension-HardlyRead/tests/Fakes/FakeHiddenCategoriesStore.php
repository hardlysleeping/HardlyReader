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
		private string $passcode = '',
	) {
	}

	/**
	 * @return list<int|string>
	 */
	public function hiddenIds(): array
	{
		return $this->hiddenIds;
	}

	/**
	 * Changes the state the way the website's own buttons would: behind the
	 * adapter's back, which is exactly the case the revision token exists for.
	 */
	public function hide(int $id, bool $hidden): void
	{
		$this->hiddenIds = array_values(array_filter(
			$this->hiddenIds,
			static fn ($existing): bool => (int) $existing !== $id,
		));
		if ($hidden) {
			$this->hiddenIds[] = $id;
		}
	}

	public function setLocked(bool $locked): void
	{
		$this->locked = $locked;
	}

	public function mode(): string
	{
		return $this->mode;
	}

	public function view(): string
	{
		return $this->view;
	}

	/**
	 * The fake keeps the locked flag independent of the passcode: tests set one
	 * or the other deliberately, and the real store's "no passcode means never
	 * locked" rule is its own behaviour, not the router's to model.
	 */
	public function isLocked(): bool
	{
		return $this->locked;
	}

	public function hasPasscode(): bool
	{
		return $this->passcode !== '';
	}
}
