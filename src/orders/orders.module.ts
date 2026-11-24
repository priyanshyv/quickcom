import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  ParseIntPipe,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CartModule } from '../cart/cart.module';
import { OutboxService, orderEventsQueueProvider } from '../outbox/outbox.service';
import { OutboxRelayService } from '../outbox/outbox-relay.service';
import { OrderEventsConsumer } from '../outbox/order-events.consumer';
import { MockGatewayService, WebhookEvent } from '../payments/mock-gateway.service';
import { PaymentsService } from '../payments/payments.service';
import { WebhooksService } from '../payments/webhooks.service';
import { OrderStateService } from './order-state.service';
import { OrderSweeperService } from './order-sweeper.service';
import { OrdersService } from './orders.service';
import { PAYMENT_SCENARIOS, PaymentLabService, PaymentScenario } from './payment-lab.service';

class PlaceOrderDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  cartId: string;
}

class CancelDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  cartId: string;
}

// ── Customer ──────────────────────────────────────────────────────────────────
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  // "Place order". The app sends Idempotency-Key: <random id made when the
  // customer tapped>, and re-sends the SAME key on any retry.
  @Post()
  place(@Body() b: PlaceOrderDto, @Headers('idempotency-key') key: string) {
    return this.orders.place(b.cartId, key);
  }

  @Get()
  list(@Query('customer') customer: string) {
    return this.orders.listForCustomer(customer);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.get(id);
  }

  // "Pay ₹105". Opens (or reuses) a payment attempt at the gateway.
  @Post(':id/payments')
  pay(@Param('id', ParseIntPipe) id: number) {
    return this.payments.start(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @Body() b: CancelDto) {
    return this.orders.cancel(id, b.cartId);
  }
}

// ── The pretend gateway's own pages (in real life: Razorpay's servers / the UPI app) ──
class CompleteDto {
  @IsIn(['success', 'failure'])
  outcome: 'success' | 'failure';

  @IsOptional()
  @IsIn(['none', 'duplicate', 'delay', 'lost'])
  chaos?: 'none' | 'duplicate' | 'delay' | 'lost';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30000)
  delayMs?: number;
}

@Controller('mock-gateway/payments')
export class MockGatewayController {
  constructor(private readonly gateway: MockGatewayService) {}

  @Get(':ref')
  get(@Param('ref') ref: string) {
    return this.gateway.getPayment(ref);
  }

  // The customer finishing (or failing) payment in their UPI app.
  @Post(':ref/complete')
  @HttpCode(200)
  complete(@Param('ref') ref: string, @Body() b: CompleteDto) {
    return this.gateway.complete(ref, b.outcome, { chaos: b.chaos, delayMs: b.delayMs });
  }
}

// ── Webhooks (called BY the gateway) ──────────────────────────────────────────
@Controller('webhooks/payment')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // Answer 200 for anything we've safely stored (including duplicates), so the
  // gateway stops retrying. Only a bad signature gets a 4xx.
  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('x-mock-signature') signature: string) {
    return this.webhooks.handle(req.rawBody, signature);
  }

  @Post('naive')
  @HttpCode(200)
  receiveNaive(@Body() evt: WebhookEvent) {
    return this.webhooks.handleNaive(evt);
  }
}

// ── Pharmacist + ops + labs ───────────────────────────────────────────────────
class RxDecisionDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  note?: string;
}

class PaymentLabDto {
  @IsIn(PAYMENT_SCENARIOS as unknown as string[])
  scenario: PaymentScenario;

  @IsIn(['right', 'naive'])
  handler: 'right' | 'naive';
}

class OriginalDto {
  @IsInt() skuId: number;
  @IsInt() onHand: number;
  @IsInt() reserved: number;
}
class ArmBody {
  @IsString() runId: string;
  @IsInt() storeId: number;
  @IsInt() units: number;
  @IsArray() @IsInt({ each: true }) skuIds: number[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => OriginalDto) originals: OriginalDto[];
}
class LabFinishDto {
  @ValidateNested() @Type(() => ArmBody) arm: ArmBody;
  @IsOptional() @IsInt() orderId?: number;
}

@Controller('admin')
export class OrdersAdminController {
  constructor(
    private readonly ds: DataSource,
    private readonly orders: OrdersService,
    private readonly sweeper: OrderSweeperService,
    private readonly relay: OutboxRelayService,
    private readonly gateway: MockGatewayService,
    private readonly paymentLab: PaymentLabService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('rx-queue')
  rxQueue() {
    return this.orders.rxQueue();
  }

  @Post('orders/:id/rx')
  @HttpCode(200)
  rx(@Param('id', ParseIntPipe) id: number, @Body() b: RxDecisionDto) {
    return this.orders.rxDecision(id, b.approve, b.note ?? '');
  }

  // Run the reconcile + timeout sweep now (it also runs every 5 s in workers).
  @Post('orders/sweep')
  @HttpCode(200)
  sweep() {
    return this.sweeper.runOnce();
  }

  @Post('outbox/relay')
  @HttpCode(200)
  async relayNow() {
    return { published: await this.relay.runOnce() };
  }

  @Get('outbox/stats')
  outboxStats() {
    return this.relay.stats();
  }

  @Get('webhooks/deliveries')
  deliveries() {
    return this.gateway.deliveries.slice(-50).reverse();
  }

  // The payment chaos lab (public/payments-lab.html).
  @Get('lab/payments')
  stories() {
    return this.paymentLab.stories();
  }

  @Post('lab/payments')
  @HttpCode(200)
  runLab(@Body() b: PaymentLabDto) {
    return this.paymentLab.run(b.scenario, b.handler);
  }

  // For load/04-checkout.js: an order waiting for payment, with an open attempt.
  @Post('lab/payments/prepare')
  async prepare() {
    const p = await this.paymentLab.prepare();
    const pay = await this.payments.start(p.orderId);
    return { ...p, paymentRef: pay.paymentRef };
  }

  @Post('lab/payments/finish')
  @HttpCode(200)
  async finishLab(@Body() b: LabFinishDto) {
    await this.gateway.idle();
    await this.paymentLab.settle();
    const report = b.orderId ? await this.paymentLab.report(b.arm, b.orderId) : null;
    await this.paymentLab.cleanup(b.arm);
    return report;
  }

  // For the k6 journey: how did the run's orders end up?
  @Get('lab/orders-summary')
  async summary(@Query('prefix') prefix: string) {
    if (!/^lab-[a-z0-9]+$/.test(prefix ?? '')) return { error: 'prefix must look like lab-<runId>' };
    await this.gateway.idle();
    await this.paymentLab.settle();
    const byStatus = await this.ds.query(
      `SELECT status, count(*)::int AS n FROM orders WHERE customer_ref LIKE $1 GROUP BY status ORDER BY status`,
      [prefix + '-%'],
    );
    const [sms] = await this.ds.query(
      `SELECT count(*)::int AS n FROM notifications n JOIN orders o ON o.id = n.order_id WHERE o.customer_ref LIKE $1`,
      [prefix + '-%'],
    );
    const [lag] = await this.ds.query(
      `SELECT coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM n.created_at - x.created_at) * 1000), 0)::int AS p95,
              coalesce(avg(extract(epoch FROM n.created_at - x.created_at) * 1000), 0)::int AS avg
       FROM notifications n JOIN outbox x ON x.id = n.event_id JOIN orders o ON o.id = n.order_id
       WHERE o.customer_ref LIKE $1`,
      [prefix + '-%'],
    );
    return { byStatus, sms: sms.n, eventToSmsMs: lag };
  }

  @Post('lab/orders-cleanup')
  @HttpCode(200)
  async cleanupOrders(@Body() b: LabFinishDto) {
    await this.paymentLab.cleanup(b.arm);
    return { ok: true };
  }
}

@Module({
  imports: [CartModule],
  controllers: [OrdersController, MockGatewayController, WebhooksController, OrdersAdminController],
  providers: [
    orderEventsQueueProvider,
    OutboxService,
    OutboxRelayService,
    OrderEventsConsumer,
    OrderStateService,
    OrdersService,
    PaymentsService,
    MockGatewayService,
    WebhooksService,
    OrderSweeperService,
    PaymentLabService,
  ],
})
export class OrdersModule {}
