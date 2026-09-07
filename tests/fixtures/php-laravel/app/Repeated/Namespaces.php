<?php

namespace Fixture\Repeated {
    use Fixture\Models\Order;

    final class First
    {
        public function order(): Order
        {
            return new Order();
        }
    }
}

namespace Fixture\Repeated {
    use Fixture\Models\Order;

    final class Second
    {
        public function order(): Order
        {
            return new Order();
        }
    }
}
