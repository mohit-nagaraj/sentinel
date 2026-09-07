<?php

namespace Fixture\Services;

use Fixture\Contracts\CreatesOrders;
use Fixture\Models\Order;
use Fixture\Repositories\OrderRepository;
use Fixture\Requests\CreateOrderRequest;

final class OrderService implements CreatesOrders
{
    public function __construct(private readonly OrderRepository $orders)
    {
    }

    public function create(CreateOrderRequest $request): Order
    {
        return $this->orders->save($request);
    }
}
