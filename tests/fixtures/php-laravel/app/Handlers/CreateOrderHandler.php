<?php

namespace Fixture\Handlers;

use Fixture\Models\Order;
use Fixture\Requests\CreateOrderRequest;
use Fixture\Services\OrderService;
use Fixture\Traits\AuditsOrders;

final class CreateOrderHandler
{
    use AuditsOrders;

    public function __construct(private readonly OrderService $service)
    {
    }

    public function handle(CreateOrderRequest $request): Order
    {
        $this->audit('creating');

        return $this->service->create($request);
    }
}
