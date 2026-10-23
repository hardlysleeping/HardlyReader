<?php
declare(strict_types=1);

/**
 * Favorite Categories 1.3.2's write surface, mirrored closely enough that the
 * router is tested against real behaviour rather than a stub that always says
 * yes:
 *
 *   setCategoryFavorite() reports ok:true with converged:false when the feed
 *   sweep fails — the state is saved either way, and `changed` follows the
 *   store, so repeating a favorite is never a change.
 *
 *   changeView() reports ok:false with converged:false when the sweep fails,
 *   also with the view already saved. That is why the router has to read the
 *   store back instead of trusting the flags alone.
 *
 * `setResult` / `viewResult` override the whole return value and leave the
 * store untouched: they are the "the write itself failed" case.
 */
final class FakeFavoriteCategories extends FakeFavoriteCategoriesReadOnly
{
	/** Saved, feed sweep failed. */
	public bool $sweepFails = false;

	/** View saved, feed sweep failed. */
	public bool $viewSweepFails = false;

	/** @var array<string, mixed>|null */
	public ?array $setResult = null;

	/** @var array<string, mixed>|null */
	public ?array $viewResult = null;

	/** @var array{0:int, 1:bool}|null */
	public ?array $lastFavoriteCall = null;

	public ?string $lastViewCall = null;

	public int $favoriteCalls = 0;

	public int $viewCalls = 0;

	/**
	 * @return array<string, mixed>
	 */
	public function setCategoryFavorite(int $catId, bool $favorite): array
	{
		$this->favoriteCalls++;
		$this->lastFavoriteCall = [$catId, $favorite];

		if ($this->setResult !== null) {
			return $this->setResult;
		}
		if ($this->categoryName($catId) === null) {
			return [
				'ok' => false,
				'changed' => false,
				'converged' => false,
				'catId' => $catId,
				'favorite' => $favorite,
				'message' => 'Category ' . $catId . ' no longer exists — nothing changed.',
			];
		}

		$wasFavorite = in_array($catId, $this->store()->favIds(), true);
		$favorite ? $this->store()->addFavorite($catId) : $this->store()->removeFavorite($catId);
		$result = [
			'ok' => true,
			'changed' => $wasFavorite !== $favorite,
			'converged' => !$this->sweepFails,
			'catId' => $catId,
			'favorite' => $favorite,
			'message' => $this->sweepFails
				? 'Saved. But some feeds could not be updated.'
				: 'Saved.',
		];

		return $result;
	}

	/**
	 * @return array<string, mixed>
	 */
	public function changeView(string $view): array
	{
		$this->viewCalls++;
		$this->lastViewCall = $view;

		if ($this->viewResult !== null) {
			return $this->viewResult;
		}

		$before = $this->store()->view();
		$this->store()->setView($view);

		if ($this->viewSweepFails) {
			return [
				'ok' => false,
				'changed' => $before !== $view,
				'converged' => false,
				'view' => $view,
				'message' => 'View saved, but some feeds could not be updated.',
			];
		}

		return [
			'ok' => true,
			'changed' => $before !== $view,
			'converged' => true,
			'view' => $view,
			'message' => 'Saved.',
		];
	}
}
