<?php
declare(strict_types=1);

/**
 * Current Hidden Categories, as the adapter will see it once the
 * setCategoryHidden()/changeView() commit lands.
 *
 * Records the last write so a test can prove the router called (or did not
 * call) the collaborator.
 */
final class FakeHiddenCategories extends FakeHiddenCategoriesReadOnly
{
	/** @var array<string, mixed> */
	public array $categoryResult = [
		'ok' => true,
		'changed' => true,
		'message' => 'Updated.',
	];

	/** @var array<string, mixed> */
	public array $viewResult = [
		'ok' => true,
		'changed' => true,
		'message' => 'Updated.',
	];

	/** @var array{0:int, 1:bool}|null */
	public ?array $lastCategoryCall = null;

	public ?string $lastViewCall = null;

	public int $categoryCalls = 0;

	public int $viewCalls = 0;

	/**
	 * @return array<string, mixed>
	 */
	public function setCategoryHidden(int $categoryId, bool $hidden): array
	{
		$this->categoryCalls++;
		$this->lastCategoryCall = [$categoryId, $hidden];

		return $this->categoryResult;
	}

	/**
	 * @return array<string, mixed>
	 */
	public function changeView(string $view): array
	{
		$this->viewCalls++;
		$this->lastViewCall = $view;

		return $this->viewResult;
	}
}
