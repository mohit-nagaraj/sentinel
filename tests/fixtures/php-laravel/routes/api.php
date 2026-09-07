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

Route::prefix($computedPrefix)->group(function (): void {
    Route::get('computed-prefix', OrderAction::class);
});

Route::match($computedMethods, 'computed-methods', OrderAction::class);
Route::post('explicit-missing', [OrderAction::class, 'missing']);
Route::post('invalid-constant', [OrderAction::TARGET, '__invoke']);
