<?php
declare(strict_types=1);

/**
 * Sidebar Feed Indent, read-only: one clamped integer, nothing else.
 */
final class FakeSidebarIndent
{
	public function __construct(private int $px = 12)
	{
	}

	public function indent(): int
	{
		return $this->px;
	}
}
