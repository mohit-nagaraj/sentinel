<?php

use Fixture\Actions\CreateOrderAction as OrderAction;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Route;

$router = app()->get('router');

Route::prefix('api')
    ->middleware(['auth:sanctum'])
    ->group(function (): void {
        Route::prefix('v1')->group(function (): void {
            Route::post('events/{event}/orders', OrderAction::class)
                ->name('orders.store');

            Route::get($dynamicPath, fn () => null);
        });
    });

$router->prefix('legacy')->group(function (Router $router): void {
    $router->put('orders/{order}', OrderAction::class);
});
