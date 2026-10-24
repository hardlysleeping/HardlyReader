<?php
declare(strict_types=1);

/**
 * Sidebar Feed Indent: one clamped integer, and a record of what was written.
 *
 * The cap is 60, the same as the real extension, so a test that posts 90 fails
 * here the same way it would on a server.
 */
final class FakeSidebarIndent
{
	public int $writes = 0;

	public function __construct(private int $px = 12)
	{
	}

	public function indent(): int
	{
		return $this->px;
	}

	public function maxIndent(): int
	{
		return 60;
	}

	public function setIndent(int $px): int
	{
		$this->writes++;
		$this->px = max(0, min(60, $px));

		return $this->px;
	}
}
