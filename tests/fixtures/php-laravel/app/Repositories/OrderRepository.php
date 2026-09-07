<?php

namespace Fixture\Repositories;

use Fixture\Models\Order as OrderModel;
use Fixture\Requests\CreateOrderRequest;

final class OrderRepository
{
    public function save(CreateOrderRequest $request): OrderModel
    {
        $order = new OrderModel();
        $order->status = 'created';

        return $order;
    }
}
