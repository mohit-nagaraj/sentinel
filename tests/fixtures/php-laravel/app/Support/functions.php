<?php

namespace Fixture\Support;

function normalize_order(string $value): string
{
    return strtolower(trim($value));
}
