import { CalendarDays, Check, LockKeyhole, Ticket } from "lucide-react"

export default function CheckoutFixturePage() {
  return (
    <main className="min-h-svh bg-[#f4f5f4] px-5 py-8 text-[#171a19] sm:px-10">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="border border-[#d9ddda] bg-white">
          <header className="flex min-h-16 items-center gap-3 border-b border-[#e3e6e4] px-5">
            <span className="grid size-8 place-items-center rounded-md bg-[#146c4a] text-white">
              <Ticket className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-sm font-semibold">Northstar Sessions</h1>
              <p className="text-xs text-[#68716d]">Secure attendee checkout</p>
            </div>
          </header>
          <div className="grid gap-6 p-5 sm:p-7">
            <div className="flex items-center gap-2 text-xs font-medium text-[#146c4a]">
              <span className="grid size-6 place-items-center rounded-full bg-[#e5f2ec]">
                1
              </span>
              <span>Details</span>
              <span className="h-px flex-1 bg-[#cfd6d2]" />
              <span className="grid size-6 place-items-center rounded-full bg-[#146c4a] text-white">
                2
              </span>
              <span>Review</span>
              <span className="h-px flex-1 bg-[#cfd6d2]" />
              <span className="grid size-6 place-items-center rounded-full bg-[#edf0ee] text-[#68716d]">
                3
              </span>
              <span className="text-[#68716d]">Complete</span>
            </div>

            <div>
              <p className="text-xs font-semibold text-[#68716d] uppercase">
                Review registration
              </p>
              <h2 className="mt-1 text-xl font-semibold">
                Frontend Systems Workshop
              </h2>
              <div className="mt-3 flex flex-wrap gap-4 text-sm text-[#4e5753]">
                <span className="flex items-center gap-2">
                  <CalendarDays className="size-4" aria-hidden="true" />
                  Sep 18, 2026 / 10:00
                </span>
                <span className="flex items-center gap-2">
                  <Ticket className="size-4" aria-hidden="true" />
                  General admission
                </span>
              </div>
            </div>

            <dl className="divide-y divide-[#e3e6e4] border-y border-[#e3e6e4] text-sm">
              <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 py-3">
                <dt className="text-[#68716d]">Attendee</dt>
                <dd className="font-medium">Demo attendee</dd>
              </div>
              <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 py-3">
                <dt className="text-[#68716d]">Delivery</dt>
                <dd className="font-medium">Digital ticket</dd>
              </div>
              <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 py-3">
                <dt className="text-[#68716d]">Payment</dt>
                <dd className="font-medium">Not required for this fixture</dd>
              </div>
            </dl>

            <div className="flex items-start gap-3 border-l-2 border-[#146c4a] bg-[#f1f8f5] px-4 py-3 text-sm">
              <Check
                className="mt-0.5 size-4 shrink-0 text-[#146c4a]"
                aria-hidden="true"
              />
              <p>
                The checkout state is ready for final confirmation. No external
                side effect has occurred.
              </p>
            </div>
          </div>
        </section>

        <aside
          className="grid content-start gap-4 border border-[#d9ddda] bg-white p-5"
          aria-label="Order summary"
        >
          <h2 className="text-sm font-semibold">Order summary</h2>
          <div className="flex items-start justify-between gap-4 border-b border-[#e3e6e4] pb-4 text-sm">
            <div>
              <p className="font-medium">General admission</p>
              <p className="mt-1 text-xs text-[#68716d]">Quantity 1</p>
            </div>
            <p className="font-semibold">Fixture</p>
          </div>
          <div className="flex items-center justify-between text-sm font-semibold">
            <span>Total</span>
            <span>No charge</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#68716d]">
            <LockKeyhole className="size-4 text-[#146c4a]" aria-hidden="true" />
            Synthetic local test data
          </div>
        </aside>
      </div>
    </main>
  )
}
