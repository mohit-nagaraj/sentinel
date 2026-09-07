<?php

namespace Fixture\Domain;

use Fixture\Actions\CreateOrderAction;

final class Route
{
    public static function get(string $path, string $action): void
    {
    }
}

Route::get('/not-a-laravel-route', CreateOrderAction::class);
