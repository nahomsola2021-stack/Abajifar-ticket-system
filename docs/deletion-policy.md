# Deletion policy

Tab	Delete button?	What should happen
Operations Overview	No	This is your dashboard. It displays information; it doesn't own business records.
Bookings & PNRs	Sometimes	Delete an unused draft booking. Cancel a confirmed booking instead of deleting its history.
Ticket Sales	Sometimes	Remove an erroneous, unissued draft sale if nothing depends on it. Issued tickets should use the appropriate ticket action, not Delete.
Customers & Corporate	Sometimes	Delete a duplicate or unused customer with no transactions. Otherwise, deactivate the customer.
Airline & Rail Suppliers	No permanent delete	Deactivate a supplier that is no longer used. Keep past bills and payments linked to it.
Financials & BSP	Drafts only	Delete draft invoices if safe. Issued invoices should be cancelled or voided with a recorded reason.
Customer Payments	No permanent delete	Reverse or void an incorrect payment while preserving the audit history.
Supplier Payments	No permanent delete	Reverse or void an incorrect payment with a reason and appropriate authorization.
Business Expenses	No permanent delete	Void an incorrect expense and record why it was voided.

## 2. Other records that need deletion controls

### Staff members
Use Deactivate instead of Delete. The former employee's past actions, payments and audit history must remain available.

### Documents
Allow authorized staff to remove an incorrectly uploaded document, but record the action and protect documents that are required for financial records.

### Passengers and flight segments
Allow removal while the booking is still editable and no ticketing has begun. Once ticketing starts, restrict editing and preserve the ticket history.

### Ticketing requests
Use Cancel for a request that should no longer proceed. Keep the request and its history for future reference.

## 3. The three actions your system should distinguish

### Delete
Removes an unused or mistaken record when no financial, ticketing, or other historical records depend on it.
Example: An empty draft booking created by accident.

### Void or Cancel
Marks a transaction or process as invalid or discontinued, without erasing the history.
Example: An issued invoice that must be cancelled, or a booking that will no longer proceed.

### Deactivate or Archive
Hides an old record from normal working lists but keeps it available for historical reference.
Example: A supplier your company no longer uses.

## 4. Rules for every Delete button
- Always show a confirmation dialog before deletion.
- Explain what will be deleted and whether the action can be undone.
- Block deletion if the record has dependent tickets, invoices, payments or other important history.
- Require a reason for voiding financial records.
- Enforce permissions in the backend, not just by hiding buttons in the frontend.
- Record sensitive changes in the audit log.
- Never permanently delete issued ticket history or completed financial transactions through a generic Delete button.
