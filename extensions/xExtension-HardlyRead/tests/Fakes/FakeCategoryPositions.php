<?php
declare(strict_types=1);

/**
 * A category table standing in for FreshRSS's `_category` rows.
 *
 * Pins are read from and written to the categories' own `position` attribute,
 * so the fake models exactly that: a list of id/name/position rows, a write
 * that moves one of them, and a record of every write so a test can prove the
 * router did not write when it should not have.
 *
 * The real store is extension.php's two closures (one reads the DAO, one
 * writes through the model); HardlyReadPins sits on top of them and owns the
 * arithmetic, so the tests here exercise the real class rather than a stub of
 * it.
 */
final class FakeCategoryPositions
{
	/** @var list<array{id: int, name: string, position: int|null}> */
	private array $rows;

	/** @var list<array{id: int, position: int|null}> Every write attempted, in order. */
	public array $writes = [];

	/** How many times the rows were read — the pin path reads once per call. */
	public int $listCalls = 0;

	/** When set, the next write reports this code instead of succeeding. */
	public ?string $failWith = null;

	/**
	 * @param array<int, int|null> $positions category id → stored position (null = not pinned)
	 * @param array<int, string> $names category id → name, for the tie-break
	 */
	public function __construct(array $positions = [], array $names = [])
	{
		$this->rows = [];
		foreach ($positions as $id => $position) {
			$id = (int) $id;
			$this->rows[] = [
				'id' => $id,
				'name' => $names[$id] ?? ('Category ' . $id),
				'position' => is_int($position) ? $position : null,
			];
		}
	}

	/** @return list<array{id: int, name: string, position: int|null}> */
	public function rows(): array
	{
		$this->listCalls++;

		return $this->rows;
	}

	/** @return array{ok: bool, code?: string} */
	public function write(int $catId, ?int $position): array
	{
		$this->writes[] = ['id' => $catId, 'position' => $position];
		if ($this->failWith !== null) {
			return ['ok' => false, 'code' => $this->failWith];
		}
		foreach ($this->rows as $index => $row) {
			if ($row['id'] === $catId) {
				$this->rows[$index]['position'] = $position;

				return ['ok' => true];
			}
		}

		return ['ok' => false, 'code' => 'category_not_found'];
	}

	/** The real class, wired to this fake's two closures. */
	public function pins(): HardlyReadPins
	{
		return new HardlyReadPins(
			rows: fn (): array => $this->rows(),
			write: fn (int $catId, ?int $position): array => $this->write($catId, $position),
		);
	}

	/** What is stored for one category right now. */
	public function positionOf(int $catId): ?int
	{
		foreach ($this->rows as $row) {
			if ($row['id'] === $catId) {
				return $row['position'];
			}
		}

		return null;
	}
}
