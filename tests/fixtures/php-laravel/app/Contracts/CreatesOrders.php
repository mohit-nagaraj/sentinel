<?php

namespace Fixture\Contracts;

use Fixture\Models\Order;
use Fixture\Requests\CreateOrderRequest;

interface CreatesOrders
{
    public function create(CreateOrderRequest $request): Order;
}
