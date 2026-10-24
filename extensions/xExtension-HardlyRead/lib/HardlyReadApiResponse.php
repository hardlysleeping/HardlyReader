<?php
declare(strict_types=1);

/**
 * One response from the HardlyRead API router.
 *
 * Pure data. Nothing is emitted, buffered or ended here: the transport in
 * extension.php decides what to do with it, which is what lets the router be
 * tested without a web server.
 */
final readonly class HardlyReadApiResponse
{
	/**
	 * @param array<string, mixed> $body
	 * @param array<string, string> $headers Extra response headers, e.g. Allow.
	 */
	public function __construct(
		public int $status,
		public array $body,
		public array $headers = [],
	) {
	}
}
