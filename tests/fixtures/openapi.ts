export const openApiOrderFixture = `openapi: 3.1.0
info:
  title: Orders
  version: 1.0.0
servers:
  - url: https://api.example.test/api/v1
paths:
  /events/{event_id}/orders:
    parameters:
      - $ref: '#/components/parameters/EventId'
    post:
      operationId: createOrder
      tags: [Orders, Public]
      requestBody:
        $ref: '#/components/requestBodies/CreateOrder'
      responses:
        '201':
          $ref: '#/components/responses/OrderCreated'
components:
  parameters:
    EventId:
      name: event_id
      in: path
      required: true
      schema:
        type: string
  requestBodies:
    CreateOrder:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/CreateOrderRequest'
  responses:
    OrderCreated:
      description: Created
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Order'
  schemas:
    CreateOrderRequest:
      type: object
      properties:
        email:
          type: string
    Order:
      type: object
      properties:
        id:
          type: string
`

export const openApiApplicationId = `application:v1:${"1".repeat(64)}` as const

export const openApiCommitSha = "2".repeat(40)
