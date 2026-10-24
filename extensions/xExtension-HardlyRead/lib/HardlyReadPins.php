<?php
declare(strict_types=1);

/**
 * The category pin order, read from and written to FreshRSS's own category
 * position.
 *
 * A pin is stored where FreshRSS already keeps folder order: the category's
 * `position` attribute. `CategoryDAO::listSortedCategories()` sorts on it
 * (nulls last, then name), `categoryController.php` writes it from the web
 * form, and ImportService preserves it — so a pin made by the app is the same
 * fact as a position typed on the website, visible to both, and it survives a
 * re-import. The GReader API cannot carry it: `tag/list` returns ids only, so
 * this adapter is the only place a client can read the order.
 *
 * This class owns no storage and no database handle. It is given two closures
 * — one that lists categories with their positions, one that writes a position
 * — so the arithmetic below (which value a pin lands on, what an unpin clears)
 * is testable without FreshRSS, and the FreshRSS side stays in extension.php
 * with the other collaborators.
 *
 * It never touches feed `priority`, and never reads or writes another
 * extension's store: pinning a feed, or a category, is the pin-keeping
 * extension's business until it comes through this route.
 */
final class HardlyReadPins
{
	/**
	 * Where a pin lands.
	 *
	 * The same value the pin-keeping extension writes when it pins a category
	 * (`TOP_POSITION = -1000` in FavoriteCategories' store): below every value
	 * the web form can produce (that field is read with paramInt and a hand-set
	 * order starts at 1), so one pin is enough to be first, and low enough that
	 * a pin made here and a pin made in the sidebar land on the same number.
	 *
	 * Pins that share the value are ordered by name — which is exactly what the
	 * main site does with them, so the order the app shows is the order the site
	 * shows, not a second opinion.
	 */
	public const PIN_POSITION = -1000;

	/** @var Closure(): list<array{id: int, name: string, position: int|null}> */
	private Closure $rows;

	/** @var Closure(int, int|null): array{ok: bool, code?: string} */
	private Closure $write;

	/**
	 * @param callable(): list<array{id: int, name: string, position: int|null}> $rows
	 * @param callable(int, int|null): array{ok: bool, code?: string} $write
	 */
	public function __construct(callable $rows, callable $write)
	{
		$this->rows = Closure::fromCallable($rows);
		$this->write = Closure::fromCallable($write);
	}

	/**
	 * The pinned categories, top first — the only list `/v1/state` reports.
	 *
	 * A category with no position is not pinned and is left out; the client
	 * already has every category from `hiddenCategories.categories`, so all it
	 * needs here is which ones are pinned and in what order.
	 *
	 * Ties (two categories sharing a position, which the web form allows) are
	 * broken by name, the same rule core uses in listSortedCategories().
	 *
	 * @return list<int>
	 */
	public function pinnedIds(): array
	{
		$pinned = [];
		foreach ($this->rows() as $row) {
			// A pin is a negative position. The web form's own ordering starts at
			// 1, so a category merely dragged up the list is ordered, not pinned,
			// and is left out — the same distinction the sidebar extension makes.
			if ($row['position'] !== null && $row['position'] < 0) {
				$pinned[] = $row;
			}
		}

		usort($pinned, static function (array $a, array $b): int {
			$byPosition = $a['position'] <=> $b['position'];

			return $byPosition !== 0 ? $byPosition : strcmp($a['name'], $b['name']);
		});

		return array_map(static fn (array $row): int => $row['id'], $pinned);
	}

	/** @return array{available: true, categories: list<int>} */
	public function snapshot(): array
	{
		return ['available' => true, 'categories' => $this->pinnedIds()];
	}

	/**
	 * Pins a category at the top, or clears its position.
	 *
	 * Idempotent in both directions: pinning something already pinned keeps
	 * its place instead of re-ranking it, and unpinning something that was
	 * never pinned writes nothing. A repeat press therefore reports
	 * `changed: false` rather than moving the row under the user's finger.
	 *
	 * @return array{ok: bool, changed?: bool, code?: string}
	 */
	public function pin(int $catId, bool $pinned): array
	{
		if ($catId <= 0) {
			return ['ok' => false, 'code' => 'invalid_category'];
		}

		$rows = $this->rows();
		$current = null;
		$found = false;
		foreach ($rows as $row) {
			if ($row['id'] === $catId) {
				$found = true;
				$current = $row['position'];
				break;
			}
		}
		if (!$found) {
			return ['ok' => false, 'code' => 'category_not_found'];
		}

		if ($pinned && $current !== null) {
			return ['ok' => true, 'changed' => false];
		}
		if (!$pinned && $current === null) {
			return ['ok' => true, 'changed' => false];
		}

		$target = $pinned ? self::PIN_POSITION : null;

		$result = ($this->write)($catId, $target);
		$result = is_array($result) ? $result : [];
		if (($result['ok'] ?? false) !== true) {
			return [
				'ok' => false,
				'code' => is_string($result['code'] ?? null) && $result['code'] !== '' ? $result['code'] : 'save_failed',
			];
		}

		return ['ok' => true, 'changed' => true];
	}

	/**
	 * The collaborator's rows, made safe to compute on.
	 *
	 * Anything malformed is dropped rather than allowed to reach the sort or
	 * the write: this data comes from a JSON column a hand edit or an old
	 * import can have filled with anything.
	 *
	 * @return list<array{id: int, name: string, position: int|null}>
	 */
	private function rows(): array
	{
		$rows = [];
		foreach (($this->rows)() as $row) {
			if (!is_array($row)) {
				continue;
			}
			$id = (int) ($row['id'] ?? 0);
			if ($id <= 0) {
				continue;
			}
			$position = $row['position'] ?? null;
			$rows[] = [
				'id' => $id,
				'name' => is_string($row['name'] ?? null) ? $row['name'] : '',
				'position' => is_int($position) ? $position : null,
			];
		}

		return $rows;
	}
}
