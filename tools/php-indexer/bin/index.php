<?php declare(strict_types=1);

use Sentinel\PhpIndexer\Extractor;
use Sentinel\PhpIndexer\IndexerException;

if (PHP_SAPI !== 'cli' || $argc !== 1) {
    fwrite(STDERR, "indexer_error:invalid_input\n");
    exit(64);
}

require dirname(__DIR__) . '/vendor/autoload.php';

try {
    $maximumRequestBytes = 4 * 1024 * 1024;
    $input = stream_get_contents(STDIN, $maximumRequestBytes + 1);
    if (!is_string($input) || $input === '' || strlen($input) > $maximumRequestBytes) {
        throw new IndexerException('limit_exceeded');
    }
    $request = json_decode($input, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($request)) {
        throw new IndexerException('invalid_input');
    }
    $response = (new Extractor())->extract($request);
    $json = json_encode($response, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    fwrite(STDOUT, $json . "\n");
} catch (IndexerException $error) {
    fwrite(STDERR, 'indexer_error:' . $error->errorCode . "\n");
    exit(65);
} catch (JsonException) {
    fwrite(STDERR, "indexer_error:invalid_input\n");
    exit(65);
} catch (Throwable) {
    fwrite(STDERR, "indexer_error:process_failed\n");
    exit(70);
}
