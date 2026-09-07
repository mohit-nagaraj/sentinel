<?php declare(strict_types=1);

namespace Sentinel\PhpIndexer;

use RuntimeException;

final class IndexerException extends RuntimeException
{
    public function __construct(public readonly string $errorCode)
    {
        parent::__construct($errorCode);
    }
}
