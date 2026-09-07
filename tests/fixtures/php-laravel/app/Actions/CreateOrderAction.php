<?php

namespace Fixture\Actions;

use Fixture\Attributes\Transactional;
use Fixture\Handlers\CreateOrderHandler as OrderHandler;
use Fixture\Requests\CreateOrderRequest;
use Fixture\Resources\OrderResource;

#[Transactional]
final class CreateOrderAction
{
    public function __construct(private readonly OrderHandler $handler)
    {
    }

    public function __invoke(CreateOrderRequest $request): OrderResource
    {
        $order = $this->handler->handle($request);

        return new OrderResource($order);
    }

    public function unresolved(object $container, string $handler): mixed
    {
        return $container->make($handler)->run();
    }
}
