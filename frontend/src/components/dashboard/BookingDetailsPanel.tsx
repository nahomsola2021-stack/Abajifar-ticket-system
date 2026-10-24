import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  CreditCard,
  Download,
  FastForward,
  FileText,
  History,
  Info,
  Paperclip,
  Plane,
  Plus,
  Send,
  Sparkles,
  Ticket,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  addBookingPassenger,
  addFlightSegment,
  createInvoice,
  createPayment,
  createTicketSale,
  createTicketingRequest,
  downloadDocument,
  fetchBookingDetails,
  fetchBookingStatusHistory,
  fetchDocuments,
  fetchInvoices,
  fetchTicketSuppliers,
  fetchTicketingRequests,
  parseItineraryWithAI,
  recordBookingTicket,
  removeBookingPassenger,
  removeFlightSegment,
  updateTicketingRequestStatus,
  uploadDocument,
} from '../../lib/api';
import type {
  BookingDetails,
  BookingPassengerCreateInput,
  BookingPassengerRecord,
  BookingRecord,
  BookingStatusHistoryEntry,
  DocumentRecord,
  DocumentType,
  FlightSegmentCreateInput,
  FlightSegmentRecord,
  InvoiceRecord,
  PaymentMethod,
  TicketCreateInput,
  TicketRecord,
  TicketSupplierRecord,
  TicketingRequestRecord,
  TicketingRequestStatus,
} from '../../types/customer';

const COMMON_AIRPORTS = [
  { code: 'ADD', name: 'Addis Ababa' },
  { code: 'DXB', name: 'Dubai' },
  { code: 'NBO', name: 'Nairobi' },
  { code: 'JED', name: 'Jeddah' },
  { code: 'RUH', name: 'Riyadh' },
  { code: 'KRT', name: 'Khartoum' },
  { code: 'JIB', name: 'Djibouti' },
  { code: 'EBB', name: 'Entebbe' },
  { code: 'JNB', name: 'Johannesburg' },
  { code: 'LHR', name: 'London Heathrow' },
  { code: 'FRA', name: 'Frankfurt' },
  { code: 'CDG', name: 'Paris Charles de Gaulle' },
  { code: 'IAD', name: 'Washington Dulles' },
  { code: 'JFK', name: 'New York JFK' },
  { code: 'YYZ', name: 'Toronto' },
  { code: 'BOM', name: 'Mumbai' },
  { code: 'DEL', name: 'New Delhi' },
  { code: 'PEK', name: 'Beijing' },
  { code: 'CAN', name: 'Guangzhou' },
  { code: 'IST', name: 'Istanbul' },
  { code: 'DOH', name: 'Doha' },
];

const CABIN_OPTIONS = [
  { value: 'Economy', label: 'Economy' },
  { value: 'Premium Economy', label: 'Premium Economy' },
  { value: 'Business', label: 'Business Class' },
  { value: 'First', label: 'First Class' },
];

const BOOKING_CLASS_OPTIONS = [
  { code: 'Y', label: 'Y — Economy (Full Fare)', cabin: 'Economy' },
  { code: 'B', label: 'B — Economy (Standard)', cabin: 'Economy' },
  { code: 'M', label: 'M — Economy (Standard)', cabin: 'Economy' },
  { code: 'H', label: 'H — Economy (Discounted)', cabin: 'Economy' },
  { code: 'Q', label: 'Q — Economy (Discounted)', cabin: 'Economy' },
  { code: 'K', label: 'K — Economy (Discounted)', cabin: 'Economy' },
  { code: 'L', label: 'L — Economy (Saver)', cabin: 'Economy' },
  { code: 'T', label: 'T — Economy (Saver)', cabin: 'Economy' },
  { code: 'V', label: 'V — Economy (Promo)', cabin: 'Economy' },
  { code: 'X', label: 'X — Economy (Promo)', cabin: 'Economy' },
  { code: 'W', label: 'W — Premium Economy', cabin: 'Premium Economy' },
  { code: 'J', label: 'J — Business (Full Fare)', cabin: 'Business' },
  { code: 'C', label: 'C — Business (Standard)', cabin: 'Business' },
  { code: 'D', label: 'D — Business (Discounted)', cabin: 'Business' },
  { code: 'Z', label: 'Z — Business (Promo)', cabin: 'Business' },
  { code: 'F', label: 'F — First Class (Full Fare)', cabin: 'First' },
  { code: 'A', label: 'A — First Class (Discounted)', cabin: 'First' },
];

const DOCUMENT_TYPE_LABELS: { value: DocumentType; label: string }[] = [
  { value: 'booking_confirmation', label: 'Booking confirmation' },
  { value: 'itinerary', label: 'Itinerary' },
  { value: 'e_ticket', label: 'E-ticket' },
  { value: 'passport', label: 'Passport / ID' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'other', label: 'Other' },
];

const TICKETING_REQUEST_STATUS_LABELS: Record<TicketingRequestStatus, string> = {
  not_requested: 'Not requested',
  pending: 'Pending',
  submitted: 'Submitted',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const TICKETING_REQUEST_NEXT_STATUSES: Record<TicketingRequestStatus, TicketingRequestStatus[]> = {
  not_requested: ['pending', 'submitted', 'cancelled'],
  pending: ['submitted', 'cancelled'],
  submitted: ['failed', 'completed', 'cancelled'],
  failed: ['pending', 'submitted', 'cancelled'],
  completed: [],
  cancelled: ['pending'],
  expired: ['pending'],
};

interface BookingDetailsPanelProps {
  booking: BookingRecord;
  onTicketRecorded: () => void;
}

const LOCKED_BOOKING_STATUSES = new Set(['cancelled', 'expired', 'closed']);

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

const WIZARD_STEPS: Array<{
  step: WizardStep;
  title: string;
  subtitle: string;
  optional?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { step: 1, title: '1. Flight Route', subtitle: 'Segments & GDS', icon: Plane },
  { step: 2, title: '2. Travelers', subtitle: 'Passenger manifest', icon: UserRound },
  {
    step: 3,
    title: '3. Partner Request',
    subtitle: 'Consolidator reminder',
    optional: true,
    icon: Send,
  },
  {
    step: 4,
    title: '4. Price & Sale',
    subtitle: 'Auto-draft invoice',
    optional: true,
    icon: TrendingUp,
  },
  { step: 5, title: '5. Issue E-Tickets', subtitle: '13-digit ticket numbers', icon: Ticket },
  { step: 6, title: '6. Cash & Docs', subtitle: 'Payments, files & audit', icon: Wallet },
];

function formatNumberWithCommas(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return '';
  const parts = cleaned.split('.');
  const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1 ? `${integerPart}.${parts[1].slice(0, 2)}` : integerPart;
}

function parseCommaNumber(formatted: string): number {
  const cleaned = formatted.replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

export const BookingDetailsPanel: React.FC<BookingDetailsPanelProps> = ({
  booking,
  onTicketRecorded,
}) => {
  const { accessToken } = useAuth();
  const [details, setDetails] = useState<BookingDetails | null>(null);
  const [suppliers, setSuppliers] = useState<TicketSupplierRecord[]>([]);
  const [loadedBookingId, setLoadedBookingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(
    accessToken ? null : 'Your session has expired. Sign in again to view booking details.',
  );
  const [success, setSuccess] = useState<string | null>(null);

  // Guided 6-Step Wizard State
  const [activeStep, setActiveStep] = useState<WizardStep>(1);
  const [step6SubTab, setStep6SubTab] = useState<'cash' | 'docs' | 'audit'>('cash');

  // Passenger & Segment Form States
  const [isSavingPassenger, setIsSavingPassenger] = useState(false);
  const [passengerType, setPassengerType] =
    useState<BookingPassengerCreateInput['passenger_type']>('ADT');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');

  const [isSavingSegment, setIsSavingSegment] = useState(false);
  const [marketingCarrier, setMarketingCarrier] = useState('');
  const [flightNumber, setFlightNumber] = useState('');
  const [originAirport, setOriginAirport] = useState('');
  const [destinationAirport, setDestinationAirport] = useState('');
  const [departureAt, setDepartureAt] = useState('');
  const [arrivalAt, setArrivalAt] = useState('');
  const [bookingClass, setBookingClass] = useState('Y');
  const [cabin, setCabin] = useState('Economy');

  // GDS Quick Parser State
  const [isGdsOpen, setIsGdsOpen] = useState(false);
  const [gdsText, setGdsText] = useState('');
  const [parsedPassengers, setParsedPassengers] = useState<BookingPassengerCreateInput[]>([]);
  const [parsedSegments, setParsedSegments] = useState<FlightSegmentCreateInput[]>([]);
  const [isParsingAI, setIsParsingAI] = useState(false);
  const [isImportingGds, setIsImportingGds] = useState(false);

  // Step 3: Ticketing Request State
  const [ticketingRequests, setTicketingRequests] = useState<TicketingRequestRecord[]>([]);
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [requestSupplierId, setRequestSupplierId] = useState('');
  const [requestDeadline, setRequestDeadline] = useState('');
  const [requestReference, setRequestReference] = useState('');
  const [savingRequestId, setSavingRequestId] = useState<number | null>(null);

  // Step 4: Commercial Sale & Auto-Invoice State
  const [isSavingSale, setIsSavingSale] = useState(false);
  const [salePassengerId, setSalePassengerId] = useState('');
  const [saleSupplierId, setSaleSupplierId] = useState('');
  const [saleSellingPrice, setSaleSellingPrice] = useState('');
  const [saleSellingCurrency, setSaleSellingCurrency] = useState('ETB');
  const [saleCost, setSaleCost] = useState('');
  const [saleCostCurrency, setSaleCostCurrency] = useState('ETB');
  const [saleNotes, setSaleNotes] = useState('');
  const [confirmHighMarkupStep4, setConfirmHighMarkupStep4] = useState(false);

  // Step 5: E-Ticket Issuance State
  const [isSavingTicket, setIsSavingTicket] = useState(false);
  const [ticketPassengerId, setTicketPassengerId] = useState('');
  const [ticketSupplierId, setTicketSupplierId] = useState('');
  const [ticketNumber, setTicketNumber] = useState('');
  const [fareAmount, setFareAmount] = useState('');
  const [ticketCurrency, setTicketCurrency] = useState('ETB');
  const [sellingPrice, setSellingPrice] = useState('');
  const [sellingCurrency, setSellingCurrency] = useState('ETB');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ticketVerified, setTicketVerified] = useState(false);
  const [confirmHighMarkupStep5, setConfirmHighMarkupStep5] = useState(false);

  // Step 6: In-Booking Financials, Documents & Audit Trail
  const [bookingInvoices, setBookingInvoices] = useState<InvoiceRecord[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesRefreshKey, setInvoicesRefreshKey] = useState(0);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentCurrency, setPaymentCurrency] = useState('ETB');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [isSavingPayment, setIsSavingPayment] = useState(false);

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentType, setDocumentType] = useState<DocumentType>('booking_confirmation');
  const [isUploading, setIsUploading] = useState(false);
  const [downloadingDocumentId, setDownloadingDocumentId] = useState<number | null>(null);
  const [documentsRefreshKey, setDocumentsRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [bookingStatusHistory, setBookingStatusHistory] = useState<
    BookingStatusHistoryEntry[] | null
  >(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const isLoading = Boolean(accessToken) && loadedBookingId !== booking.id;

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(null), 4500);
    return () => window.clearTimeout(timer);
  }, [success]);

  const handleAIParse = async () => {
    if (!accessToken || !gdsText.trim()) return;
    setIsParsingAI(true);
    setError(null);
    try {
      const result = await parseItineraryWithAI(accessToken, gdsText);
      setParsedPassengers(
        (result.passengers || []).map((p: any) => ({
          passenger_type: (p.passenger_type as 'ADT' | 'CHD' | 'INF') || 'ADT',
          first_name: p.first_name || '',
          middle_name: p.middle_name || '',
          last_name: p.last_name || '',
        })),
      );
      setParsedSegments(
        (result.segments || []).map((s: any) => ({
          marketing_carrier: s.marketing_carrier || '',
          flight_number: s.flight_number || '',
          origin_airport: s.origin_airport || '',
          destination_airport: s.destination_airport || '',
          departure_at: s.departure_at || '',
          arrival_at: s.arrival_at || '',
          booking_class: s.booking_class || 'Y',
          cabin: s.cabin || 'Economy',
        })),
      );
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'AI parsing failed.');
    } finally {
      setIsParsingAI(false);
    }
  };

  const handleImportAllParsedGds = async () => {
    if (!accessToken) return;
    setIsImportingGds(true);
    setError(null);
    try {
      const createdPassengers: BookingPassengerRecord[] = [];
      for (const p of parsedPassengers) {
        createdPassengers.push(await addBookingPassenger(accessToken, booking.id, p));
      }
      const createdSegments: FlightSegmentRecord[] = [];
      for (const s of parsedSegments) {
        createdSegments.push(await addFlightSegment(accessToken, booking.id, s));
      }
      setDetails((current) =>
        current
          ? {
              ...current,
              passengers: [...current.passengers, ...createdPassengers],
              segments: [...current.segments, ...createdSegments],
            }
          : current,
      );
      setParsedPassengers([]);
      setParsedSegments([]);
      setGdsText('');
      setIsGdsOpen(false);
      setSuccess(
        `Imported ${createdPassengers.length} traveler(s) and ${createdSegments.length} flight segment(s).`,
      );
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not import GDS records.',
      );
    } finally {
      setIsImportingGds(false);
    }
  };

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    setBookingStatusHistory(null);
    setActiveStep(1);

    fetchBookingDetails(accessToken, booking.id)
      .then((result) => {
        if (isCurrent) setDetails(result);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load booking details.',
          );
        }
      })
      .finally(() => {
        if (isCurrent) setLoadedBookingId(booking.id);
      });

    fetchTicketSuppliers(accessToken)
      .then((result) => {
        if (!isCurrent) return;
        setSuppliers(result);
        const defaultSupplierId = String(result[0]?.id ?? '');
        const defaultCurrency = result[0]?.settlement_currency.trim() || 'ETB';
        setTicketSupplierId((current) => current || defaultSupplierId);
        setSaleSupplierId((current) => current || defaultSupplierId);
        setRequestSupplierId((current) => current || defaultSupplierId);
        setTicketCurrency((current) => current || defaultCurrency);
        setSaleCostCurrency((current) => current || defaultCurrency);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load ticket suppliers.',
          );
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, booking.id]);

  useEffect(() => {
    if (!details) return;
    const unpricedPax = details.passengers.find(
      (p) => !details.tickets.some((t) => t.booking_passenger_id === p.id),
    );
    if (unpricedPax && !salePassengerId) {
      setSalePassengerId(String(unpricedPax.id));
    }

    const unticketedPax = details.passengers.find(
      (p) =>
        !details.tickets.some(
          (t) =>
            t.booking_passenger_id === p.id &&
            ['issued', 'exchanged'].includes(t.ticket_status),
        ),
    );
    if (unticketedPax && !ticketPassengerId) {
      setTicketPassengerId(String(unticketedPax.id));
    }
  }, [details, salePassengerId, ticketPassengerId]);

  useEffect(() => {
    if (!details || !ticketPassengerId) return;
    const pendingSale = details.tickets.find(
      (t) =>
        t.booking_passenger_id === Number(ticketPassengerId) &&
        t.ticket_status === 'pending',
    );
    if (pendingSale) {
      if (pendingSale.fare_amount !== null) {
        setFareAmount(formatNumberWithCommas(String(pendingSale.fare_amount)));
      }
      if (pendingSale.selling_price !== null) {
        setSellingPrice(formatNumberWithCommas(String(pendingSale.selling_price)));
      }
    }
  }, [details, ticketPassengerId]);

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchDocuments(accessToken, booking.id)
      .then((result) => {
        if (isCurrent) setDocuments(result.items);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error ? requestError.message : 'Could not load attachments.',
          );
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, booking.id, documentsRefreshKey]);

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchTicketingRequests(accessToken, booking.id)
      .then((result) => {
        if (isCurrent) setTicketingRequests(result);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load ticketing requests.',
          );
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, booking.id]);

  useEffect(() => {
    if (!accessToken || !booking.id) return;
    let isCurrent = true;
    setInvoicesLoading(true);
    fetchInvoices(accessToken, '', '', 50, 0, booking.id)
      .then((result) => {
        if (!isCurrent) return;
        setBookingInvoices(result.items);
        if (result.items[0]?.currency) {
          setPaymentCurrency(result.items[0].currency.trim());
        }
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error ? requestError.message : 'Could not load invoices.',
          );
        }
      })
      .finally(() => {
        if (isCurrent) setInvoicesLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, booking.id, invoicesRefreshKey]);

  useEffect(() => {
    if (
      !accessToken ||
      activeStep !== 6 ||
      step6SubTab !== 'audit' ||
      !booking.id ||
      bookingStatusHistory !== null
    ) {
      return;
    }
    let isCurrent = true;
    setHistoryLoading(true);
    fetchBookingStatusHistory(accessToken, booking.id)
      .then((result) => {
        if (isCurrent) setBookingStatusHistory(result);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(
            requestError instanceof Error ? requestError.message : 'Could not load audit history.',
          );
        }
      })
      .finally(() => {
        if (isCurrent) setHistoryLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, activeStep, step6SubTab, booking.id, bookingStatusHistory]);

  const handleAddPassenger = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    const passenger: BookingPassengerCreateInput = {
      passenger_type: passengerType,
      first_name: firstName.trim(),
      middle_name: middleName.trim(),
      last_name: lastName.trim(),
    };
    setIsSavingPassenger(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await addBookingPassenger(accessToken, booking.id, passenger);
      setDetails((current) =>
        current ? { ...current, passengers: [...current.passengers, created] } : current,
      );
      setFirstName('');
      setMiddleName('');
      setLastName('');
      setSuccess(`Traveler ${created.first_name} ${created.last_name} added to manifest.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not add traveler.');
    } finally {
      setIsSavingPassenger(false);
    }
  };

  const handleAddSegment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    if (departureAt && arrivalAt && new Date(arrivalAt) <= new Date(departureAt)) {
      setError('Flight arrival time must be strictly after the departure time.');
      return;
    }

    const segment: FlightSegmentCreateInput = {
      marketing_carrier: marketingCarrier.trim().toUpperCase(),
      flight_number: flightNumber.trim().toUpperCase(),
      origin_airport: originAirport.trim().toUpperCase(),
      destination_airport: destinationAirport.trim().toUpperCase(),
      departure_at: new Date(departureAt).toISOString(),
      arrival_at: new Date(arrivalAt).toISOString(),
      booking_class: bookingClass.trim().toUpperCase(),
      cabin: cabin.trim(),
    };
    setIsSavingSegment(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await addFlightSegment(accessToken, booking.id, segment);
      setDetails((current) =>
        current ? { ...current, segments: [...current.segments, created] } : current,
      );
      const prevDestination = destinationAirport.trim().toUpperCase();
      setOriginAirport(prevDestination);
      setDestinationAirport('');
      setFlightNumber('');
      setDepartureAt('');
      setArrivalAt('');
      setSuccess(
        `Flight segment ${created.origin_airport} → ${created.destination_airport} (${created.cabin || 'Economy'}) saved.`,
      );
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not add flight segment.',
      );
    } finally {
      setIsSavingSegment(false);
    }
  };

  const handleCreateRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !requestSupplierId) return;

    setIsCreatingRequest(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createTicketingRequest(accessToken, booking.id, {
        supplier_id: Number(requestSupplierId),
        ticketing_deadline: requestDeadline ? new Date(requestDeadline).toISOString() : null,
        partner_request_reference: requestReference.trim() || null,
      });
      setTicketingRequests((current) => [created, ...current]);
      setRequestReference('');
      setRequestDeadline('');
      setSuccess(`Ticketing request raised with ${created.supplier_name}.`);
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not raise the ticketing request.',
      );
    } finally {
      setIsCreatingRequest(false);
    }
  };

  const handleRequestStatusChange = async (
    request: TicketingRequestRecord,
    nextStatus: TicketingRequestStatus,
  ) => {
    if (!accessToken) return;

    setSavingRequestId(request.id);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateTicketingRequestStatus(accessToken, request.id, {
        status: nextStatus,
      });
      setTicketingRequests((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setSuccess(
        `Ticketing request moved to ${TICKETING_REQUEST_STATUS_LABELS[updated.status]}.`,
      );
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not update the ticketing request.',
      );
    } finally {
      setSavingRequestId(null);
    }
  };

  const handleRecordSale = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    const numericSellingPrice = parseCommaNumber(saleSellingPrice);
    const numericCost = parseCommaNumber(saleCost);

    if (
      saleSellingCurrency.trim().toUpperCase() === saleCostCurrency.trim().toUpperCase() &&
      numericCost > 0 &&
      numericSellingPrice > 0 &&
      numericCost > numericSellingPrice
    ) {
      setError(
        'Supplier Net Cost cannot be higher than the Customer Selling Price. Please adjust or swap the prices.',
      );
      return;
    }

    setIsSavingSale(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createTicketSale(accessToken, {
        booking_id: booking.id,
        booking_passenger_id: Number(salePassengerId),
        supplier_id: Number(saleSupplierId),
        selling_price: saleSellingPrice.trim() ? numericSellingPrice : null,
        selling_currency: saleSellingPrice.trim()
          ? saleSellingCurrency.trim().toUpperCase()
          : null,
        supplier_cost: saleCost.trim() ? numericCost : null,
        supplier_cost_currency: saleCost.trim() ? saleCostCurrency.trim().toUpperCase() : null,
        notes: saleNotes.trim() || null,
      });
      setDetails((current) =>
        current
          ? { ...current, tickets: [created as unknown as TicketRecord, ...current.tickets] }
          : current,
      );
      setSalePassengerId('');
      setSaleSellingPrice('');
      setSaleCost('');
      setSaleNotes('');
      setConfirmHighMarkupStep4(false);

      let invoiceNote: string | null = null;
      if (created.selling_price !== null && created.selling_currency) {
        try {
          const passenger = details?.passengers.find((p) => p.id === created.booking_passenger_id);
          const passengerName = passenger
            ? `${passenger.first_name} ${
                passenger.middle_name ? passenger.middle_name + ' ' : ''
              }${passenger.last_name}`.trim()
            : 'Traveler';
          const route = details?.segments.length
            ? details.segments.map((s) => `${s.origin_airport}-${s.destination_airport}`).join(', ')
            : 'Air travel';
          const invoiceNumber = `INV-${booking.booking_code.slice(-6)}-${String(Date.now()).slice(-4)}`;
          const invoice = await createInvoice(accessToken, {
            invoice_number: invoiceNumber,
            booking_id: booking.id,
            currency: created.selling_currency,
            due_date: null,
            tax_total: 0,
            discount_total: 0,
            notes: created.notes ?? '',
            items: [
              {
                item_type: 'airfare',
                description: `${passengerName} · ${route}`,
                quantity: 1,
                unit_price: Number(created.selling_price),
              },
            ],
          });
          invoiceNote = `Auto-drafted Invoice ${invoice.invoice_number}.`;
          setInvoicesRefreshKey((k) => k + 1);
        } catch {
          invoiceNote = null;
        }
      }

      setSuccess(`Commercial sale saved!${invoiceNote ? ' ' + invoiceNote : ''}`);
      onTicketRecorded();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record the sale.');
    } finally {
      setIsSavingSale(false);
    }
  };

  const handleRecordTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    const numericFareCost = parseCommaNumber(fareAmount);
    const numericSelling = parseCommaNumber(sellingPrice);

    if (
      sellingCurrency.trim().toUpperCase() === ticketCurrency.trim().toUpperCase() &&
      numericFareCost > 0 &&
      numericSelling > 0 &&
      numericFareCost > numericSelling
    ) {
      setError(
        'Supplier Net Cost cannot be higher than the Customer Selling Price. Please adjust or swap the prices.',
      );
      return;
    }

    const ticket: TicketCreateInput = {
      booking_id: booking.id,
      booking_passenger_id: Number(ticketPassengerId),
      supplier_id: Number(ticketSupplierId),
      ticket_number: ticketNumber.trim(),
      fare_amount: fareAmount.trim() ? numericFareCost : null,
      currency: fareAmount.trim() ? ticketCurrency.trim().toUpperCase() : null,
      selling_price: sellingPrice.trim() ? numericSelling : null,
      selling_currency: sellingPrice.trim() ? sellingCurrency.trim().toUpperCase() : null,
      issue_date: issueDate || null,
      verified: true,
    };
    setIsSavingTicket(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await recordBookingTicket(accessToken, booking.id, ticket);
      setDetails((current) =>
        current
          ? {
              ...current,
              tickets: [created, ...current.tickets.filter((t) => t.id !== created.id)],
            }
          : current,
      );

      for (const request of ticketingRequests) {
        if (request.status === 'pending' || request.status === 'submitted') {
          try {
            const updated = await updateTicketingRequestStatus(accessToken, request.id, {
              status: 'completed',
            });
            setTicketingRequests((current) =>
              current.map((item) => (item.id === updated.id ? updated : item)),
            );
          } catch {
            // Non-fatal
          }
        }
      }

      setTicketPassengerId('');
      setTicketNumber('');
      setFareAmount('');
      setSellingPrice('');
      setTicketVerified(false);
      setConfirmHighMarkupStep5(false);
      setSuccess(`Verified E-Ticket ${created.ticket_number} issued and saved!`);
      onTicketRecorded();
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not record the ticket.',
      );
    } finally {
      setIsSavingTicket(false);
    }
  };

  const handleCollectPayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;
    const numericPayment = parseCommaNumber(paymentAmount);
    if (!paymentAmount || numericPayment <= 0) {
      setError('Enter a valid payment amount.');
      return;
    }
    if (maxAllowedPayment > 0 && numericPayment > maxAllowedPayment) {
      setError(
        `Payment amount cannot exceed the total ticket/invoice price of ${paymentCurrency.toUpperCase()} ${formatNumberWithCommas(String(maxAllowedPayment))}.`,
      );
      return;
    }
    setIsSavingPayment(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createPayment(accessToken, {
        customer_id: booking.customer_id,
        currency: paymentCurrency.trim().toUpperCase(),
        amount: numericPayment,
        payment_method: paymentMethod,
        notes: paymentNotes.trim() || `Booking ${booking.booking_code}`,
      });
      setSuccess(
        `Receipt ${created.receipt_number ?? `#${created.id}`} recorded for ${paymentCurrency.toUpperCase()} ${formatNumberWithCommas(String(numericPayment))}.`,
      );
      setIsPaymentModalOpen(false);
      setPaymentAmount('');
      setPaymentNotes('');
      setInvoicesRefreshKey((k) => k + 1);
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not record the payment.',
      );
    } finally {
      setIsSavingPayment(false);
    }
  };

  const handleUploadDocument = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file to attach.');
      return;
    }

    setIsUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await uploadDocument(accessToken, file, documentType, booking.id);
      setDocumentsRefreshKey((key) => key + 1);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSuccess(`Attached ${created.original_filename} successfully.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not attach the file.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownloadDocument = async (document: DocumentRecord) => {
    if (!accessToken) return;
    setDownloadingDocumentId(document.id);
    setError(null);
    try {
      await downloadDocument(accessToken, document.id, document.original_filename);
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not download the attachment.',
      );
    } finally {
      setDownloadingDocumentId(null);
    }
  };

  const isLocked = LOCKED_BOOKING_STATUSES.has(booking.status);
  const issuedCount =
    details?.tickets.filter((t) => ['issued', 'exchanged'].includes(t.ticket_status)).length ?? 0;
  const unpricedPassengers =
    details?.passengers.filter(
      (p) => !details.tickets.some((t) => t.booking_passenger_id === p.id),
    ) ?? [];
  const unticketedPassengers =
    details?.passengers.filter(
      (p) =>
        !details.tickets.some(
          (r) =>
            r.booking_passenger_id === p.id &&
            ['issued', 'exchanged'].includes(r.ticket_status),
        ),
    ) ?? [];

  // --- GUARDRAIL CALCULATIONS FOR STEP 4 ---
  const step4SellingNum = parseCommaNumber(saleSellingPrice);
  const step4CostNum = parseCommaNumber(saleCost);
  const step4SameCurr =
    saleSellingCurrency.trim().toUpperCase() === saleCostCurrency.trim().toUpperCase();
  const step4Margin = step4SellingNum - step4CostNum;
  const step4IsLoss =
    step4SameCurr && step4CostNum > 0 && step4SellingNum > 0 && step4CostNum > step4SellingNum;
  const step4IsHighMarkup =
    step4SameCurr && step4CostNum > 0 && step4SellingNum > step4CostNum * 1.5;
  const step4MarkupPct =
    step4CostNum > 0 ? Math.round(((step4SellingNum - step4CostNum) / step4CostNum) * 100) : 0;

  // --- GUARDRAIL CALCULATIONS FOR STEP 5 ---
  const step5SellingNum = parseCommaNumber(sellingPrice);
  const step5CostNum = parseCommaNumber(fareAmount);
  const step5SameCurr =
    sellingCurrency.trim().toUpperCase() === ticketCurrency.trim().toUpperCase();
  const step5Margin = step5SellingNum - step5CostNum;
  const step5IsLoss =
    step5SameCurr && step5CostNum > 0 && step5SellingNum > 0 && step5CostNum > step5SellingNum;
  const step5IsHighMarkup =
    step5SameCurr && step5CostNum > 0 && step5SellingNum > step5CostNum * 1.5;
  const step5MarkupPct =
    step5CostNum > 0 ? Math.round(((step5SellingNum - step5CostNum) / step5CostNum) * 100) : 0;

  const selectedPaxPendingSale = details?.tickets.find(
    (t) =>
      t.booking_passenger_id === Number(ticketPassengerId) &&
      t.ticket_status === 'pending',
  );
  const quotedSellingPrice =
    selectedPaxPendingSale?.selling_price !== null &&
    selectedPaxPendingSale?.selling_price !== undefined
      ? Number(selectedPaxPendingSale.selling_price)
      : null;
  const step5HasPriceMismatch =
    quotedSellingPrice !== null &&
    quotedSellingPrice > 0 &&
    step5SellingNum > 0 &&
    step5SellingNum !== quotedSellingPrice;

  const totalInvoicedAmount = bookingInvoices
    .filter((inv) => inv.status !== 'cancelled')
    .reduce((sum, inv) => sum + Number(inv.grand_total || 0), 0);
  const totalTicketSellingAmount = (details?.tickets ?? []).reduce(
    (sum, t) => sum + Number(t.selling_price || 0),
    0,
  );
  const maxAllowedPayment =
    totalInvoicedAmount > 0 ? totalInvoicedAmount : totalTicketSellingAmount;
  const enteredPaymentNum = parseCommaNumber(paymentAmount);
  const isOverpayment = maxAllowedPayment > 0 && enteredPaymentNum > maxAllowedPayment;

  return (
    <div className="space-y-5">
      <datalist id="airports">
        {COMMON_AIRPORTS.map((airport) => (
          <option key={airport.code} value={airport.code}>
            {airport.name} ({airport.code})
          </option>
        ))}
      </datalist>

      {/* FLOATING POP-UP NOTIFICATION BANNER */}
      {success && (
        <div className="fixed inset-x-0 top-6 z-[100] mx-auto flex max-w-md px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex w-full items-start gap-3.5 rounded-2xl border border-emerald-200 bg-white p-4 shadow-2xl ring-4 ring-emerald-500/10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Changes Saved
              </p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{success}</p>
            </div>
            <button
              type="button"
              onClick={() => setSuccess(null)}
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed inset-x-0 top-6 z-[100] mx-auto flex max-w-md px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex w-full items-start gap-3.5 rounded-2xl border border-rose-200 bg-white p-4 shadow-2xl ring-4 ring-rose-500/10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-md">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-rose-700">
                Action Blocked
              </p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="py-12 text-center text-xs text-slate-500">
          Loading itinerary, travelers, and financial records...
        </p>
      ) : details ? (
        <>
          {/* SPACIOUS 3x2 WIZARD BAR */}
          <div className="grid grid-cols-1 gap-2.5 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-2 md:grid-cols-3">
            {WIZARD_STEPS.map((item) => {
              const Icon = item.icon;
              const isActive = activeStep === item.step;
              const isDone =
                (item.step === 1 && details.segments.length > 0) ||
                (item.step === 2 && details.passengers.length > 0) ||
                (item.step === 3 && ticketingRequests.length > 0) ||
                (item.step === 4 && details.tickets.length > 0) ||
                (item.step === 5 &&
                  details.passengers.length > 0 &&
                  issuedCount >= details.passengers.length) ||
                (item.step === 6 && bookingInvoices.length > 0);

              return (
                <button
                  key={item.step}
                  type="button"
                  onClick={() => setActiveStep(item.step)}
                  className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-all ${
                    isActive
                      ? 'bg-teal-700 text-white shadow-sm ring-2 ring-teal-700/20'
                      : isDone
                        ? 'border border-emerald-200 bg-white text-slate-900 hover:border-emerald-300'
                        : 'border border-slate-200/80 bg-white/80 text-slate-700 hover:bg-white'
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      isActive
                        ? 'bg-white/20 text-white'
                        : isDone
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {isDone && !isActive ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Icon className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <p className="text-xs font-bold leading-snug">{item.title}</p>
                      {item.optional && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                            isActive
                              ? 'bg-teal-900/50 text-teal-100'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          Skippable
                        </span>
                      )}
                    </div>
                    <p
                      className={`mt-0.5 text-[11px] leading-tight ${
                        isActive ? 'text-teal-100' : 'text-slate-500'
                      }`}
                    >
                      {item.subtitle}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* =================================================================
              STEP 1: FLIGHT ROUTE (WITH TIME VALIDATION GUARD)
          ================================================================= */}
          {activeStep === 1 && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {!isLocked && (
                <section className="rounded-xl border border-teal-200/80 bg-teal-50/30 p-3.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-teal-700" />
                      <h3 className="text-xs font-bold text-slate-900">
                        Quick-Paste GDS Itinerary (Amadeus / Sabre / Galileo)
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsGdsOpen((open) => !open)}
                      className="text-xs font-semibold text-teal-800 hover:underline"
                    >
                      {isGdsOpen ? 'Hide Parser' : 'Open AI Parser'}
                    </button>
                  </div>

                  {isGdsOpen && (
                    <div className="mt-3 space-y-2.5">
                      <textarea
                        rows={3}
                        value={gdsText}
                        onChange={(event) => setGdsText(event.target.value)}
                        placeholder={'1. KEBEDE/ABEBE MR\n2. ET 600 Y 15NOV ADD DXB 0900 1330'}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-teal-600 focus:outline-none"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleAIParse()}
                          disabled={isParsingAI}
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                          {isParsingAI ? 'AI Parsing...' : 'Preview Extract'}
                        </button>
                        {(parsedPassengers.length > 0 || parsedSegments.length > 0) && (
                          <button
                            type="button"
                            disabled={isImportingGds}
                            onClick={() => void handleImportAllParsedGds()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>
                              {isImportingGds
                                ? 'Importing...'
                                : `Confirm & Import (${parsedPassengers.length} Pax, ${parsedSegments.length} Segments)`}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}

              <section className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Plane className="h-4 w-4 text-teal-700" />
                    Step 1: Flight Itinerary{' '}
                    <span className="text-xs font-normal text-slate-500">
                      ({details.segments.length} leg{details.segments.length === 1 ? '' : 's'})
                    </span>
                  </h3>
                </div>

                {details.segments.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    No flight segments added yet. Enter the flight leg below to start the booking.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {details.segments.map((segment, idx) => (
                      <li
                        key={segment.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5"
                      >
                        <div className="flex items-center gap-3">
                          <span className="rounded bg-slate-900 px-2 py-1 font-mono text-xs font-bold text-white">
                            {[segment.marketing_carrier, segment.flight_number]
                              .filter(Boolean)
                              .join(' ') || `LEG ${idx + 1}`}
                          </span>
                          <div>
                            <div className="flex items-center gap-2 font-mono text-sm font-extrabold text-slate-900">
                              <span>{segment.origin_airport}</span>
                              <ArrowRight className="h-3.5 w-3.5 text-teal-700" />
                              <span>{segment.destination_airport}</span>
                              {segment.cabin && (
                                <span className="rounded bg-teal-50 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal-800">
                                  {segment.cabin}
                                  {segment.booking_class ? ` (${segment.booking_class})` : ''}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500">
                              {new Intl.DateTimeFormat('en', {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              }).format(new Date(segment.departure_at))}
                              {' → '}
                              {new Intl.DateTimeFormat('en', {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              }).format(new Date(segment.arrival_at))}
                            </p>
                          </div>
                        </div>
                        {!isLocked && (
                          <button
                            type="button"
                            title="Delete segment"
                            onClick={async () => {
                              if (!accessToken) return;
                              if (
                                !window.confirm(
                                  `Delete segment ${segment.origin_airport} → ${segment.destination_airport}?`,
                                )
                              )
                                return;
                              try {
                                await removeFlightSegment(accessToken, booking.id, segment.id);
                                setDetails((current) =>
                                  current
                                    ? {
                                        ...current,
                                        segments: current.segments.filter(
                                          (s) => s.id !== segment.id,
                                        ),
                                      }
                                    : current,
                                );
                                setSuccess('Flight segment removed.');
                              } catch (requestError: unknown) {
                                setError(
                                  requestError instanceof Error
                                    ? requestError.message
                                    : 'Could not remove segment.',
                                );
                              }
                            }}
                            className="rounded-md border border-rose-200 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                )}

                {!isLocked && (
                  <form
                    onSubmit={handleAddSegment}
                    className="mt-4 border-t border-slate-100 pt-4"
                  >
                    <h4 className="text-xs font-semibold text-slate-800">Add flight segment</h4>
                    <div className="mt-2 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      <label className="text-[11px] font-medium text-slate-600">
                        Origin (IATA)
                        <input
                          required
                          list="airports"
                          minLength={3}
                          maxLength={3}
                          pattern="[A-Za-z]{3}"
                          value={originAirport}
                          onChange={(e) => setOriginAirport(e.target.value.toUpperCase())}
                          placeholder="ADD"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs uppercase"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600">
                        Destination (IATA)
                        <input
                          required
                          list="airports"
                          minLength={3}
                          maxLength={3}
                          pattern="[A-Za-z]{3}"
                          value={destinationAirport}
                          onChange={(e) => setDestinationAirport(e.target.value.toUpperCase())}
                          placeholder="DXB"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs uppercase"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600">
                        Carrier <span className="font-normal">(2-letter)</span>
                        <input
                          maxLength={2}
                          pattern="[A-Za-z]{2}"
                          value={marketingCarrier}
                          onChange={(e) => setMarketingCarrier(e.target.value.toUpperCase())}
                          placeholder="ET"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs uppercase"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600">
                        Flight number
                        <input
                          maxLength={10}
                          value={flightNumber}
                          onChange={(e) => setFlightNumber(e.target.value.toUpperCase())}
                          placeholder="600"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600 sm:col-span-2">
                        Departure
                        <input
                          required
                          type="datetime-local"
                          value={departureAt}
                          onChange={(e) => {
                            const newDep = e.target.value;
                            setDepartureAt(newDep);
                            // Auto-nudge arrival if it's currently before departure
                            if (arrivalAt && new Date(arrivalAt) <= new Date(newDep)) {
                              const d = new Date(newDep);
                              d.setHours(d.getHours() + 3); // default 3 hour flight duration
                              setArrivalAt(d.toISOString().slice(0, 16));
                            }
                          }}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600 sm:col-span-2">
                        Arrival
                        <input
                          required
                          type="datetime-local"
                          min={departureAt || undefined}
                          value={arrivalAt}
                          onChange={(e) => setArrivalAt(e.target.value)}
                          className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs ${
                            departureAt && arrivalAt && new Date(arrivalAt) <= new Date(departureAt)
                              ? 'border-rose-400 bg-rose-50 text-rose-900'
                              : 'border-slate-300'
                          }`}
                        />
                      </label>

                      <label className="text-[11px] font-medium text-slate-600">
                        Cabin Class
                        <select
                          value={cabin}
                          onChange={(e) => {
                            const selectedCabin = e.target.value;
                            setCabin(selectedCabin);
                            if (selectedCabin === 'Economy') setBookingClass('Y');
                            else if (selectedCabin === 'Premium Economy') setBookingClass('W');
                            else if (selectedCabin === 'Business') setBookingClass('C');
                            else if (selectedCabin === 'First') setBookingClass('F');
                          }}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900"
                        >
                          {CABIN_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="text-[11px] font-medium text-slate-600">
                        Booking Class (RBD)
                        <select
                          value={bookingClass}
                          onChange={(e) => {
                            const selectedCode = e.target.value;
                            setBookingClass(selectedCode);
                            const matched = BOOKING_CLASS_OPTIONS.find(
                              (opt) => opt.code === selectedCode,
                            );
                            if (matched) setCabin(matched.cabin);
                          }}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs font-semibold text-slate-900"
                        >
                          {BOOKING_CLASS_OPTIONS.map((option) => (
                            <option key={option.code} value={option.code}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {departureAt && arrivalAt && new Date(arrivalAt) <= new Date(departureAt) && (
                      <p className="mt-2 text-xs font-semibold text-rose-700">
                        ⚠️ Error: Flight arrival time must be strictly after the departure time.
                      </p>
                    )}

                    <button
                      type="submit"
                      disabled={
                        isSavingSegment ||
                        (Boolean(departureAt && arrivalAt) &&
                          new Date(arrivalAt) <= new Date(departureAt))
                      }
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {isSavingSegment ? 'Adding...' : 'Save Flight Leg'}
                    </button>
                  </form>
                )}
              </section>
            </div>
          )}

          {/* =================================================================
              STEP 2: TRAVELERS MANIFEST
          ================================================================= */}
          {activeStep === 2 && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 animate-in fade-in duration-200">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <UserRound className="h-4 w-4 text-teal-700" />
                  Step 2: Travelers Manifest{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({details.passengers.length} added)
                  </span>
                </h3>
              </div>

              {details.passengers.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  No travelers added yet. Add each adult, child, or infant below.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {details.passengers.map((passenger) => {
                    const paxTickets = details.tickets.filter(
                      (t) => t.booking_passenger_id === passenger.id,
                    );
                    const issuedTicket = paxTickets.find((t) =>
                      ['issued', 'exchanged'].includes(t.ticket_status),
                    );
                    const pendingSale = paxTickets.find((t) => t.ticket_status === 'pending');

                    return (
                      <li
                        key={passenger.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {passenger.first_name}{' '}
                            {passenger.middle_name ? `${passenger.middle_name} ` : ''}
                            {passenger.last_name}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                            {passenger.passenger_type}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          {issuedTicket ? (
                            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-mono text-[11px] font-bold text-emerald-800">
                              Ticket: {issuedTicket.ticket_number}
                            </span>
                          ) : pendingSale ? (
                            <button
                              type="button"
                              onClick={() => {
                                setTicketPassengerId(String(passenger.id));
                                setActiveStep(5);
                              }}
                              className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                            >
                              Sale Recorded · Issue Ticket →
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setSalePassengerId(String(passenger.id));
                                setTicketPassengerId(String(passenger.id));
                                setActiveStep(4);
                              }}
                              className="rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800 hover:bg-teal-100"
                            >
                              Price & Issue Ticket →
                            </button>
                          )}
                          {paxTickets.length === 0 ? (
                            <button
                              type="button"
                              title="Delete traveler"
                              onClick={async () => {
                                if (!accessToken) return;
                                if (
                                  !window.confirm(
                                    `Delete traveler ${passenger.first_name} ${passenger.last_name}?`,
                                  )
                                )
                                  return;
                                try {
                                  await removeBookingPassenger(
                                    accessToken,
                                    booking.id,
                                    passenger.id,
                                  );
                                  setDetails((current) =>
                                    current
                                      ? {
                                          ...current,
                                          passengers: current.passengers.filter(
                                            (p) => p.id !== passenger.id,
                                          ),
                                        }
                                      : current,
                                  );
                                  setSuccess('Traveler removed.');
                                } catch (requestError: unknown) {
                                  setError(
                                    requestError instanceof Error
                                      ? requestError.message
                                      : 'Could not remove traveler.',
                                  );
                                }
                              }}
                              className="rounded-md border border-rose-200 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled
                              title="Cannot delete a ticketed passenger."
                              className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 p-1.5 text-slate-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!isLocked && (
                <form
                  onSubmit={handleAddPassenger}
                  className="mt-4 border-t border-slate-100 pt-4"
                >
                  <h4 className="text-xs font-semibold text-slate-800">Add traveler</h4>
                  <div className="mt-2 grid gap-2.5 sm:grid-cols-4">
                    <label className="text-[11px] font-medium text-slate-600">
                      Type
                      <select
                        value={passengerType}
                        onChange={(e) =>
                          setPassengerType(
                            e.target.value as BookingPassengerCreateInput['passenger_type'],
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      >
                        <option value="ADT">Adult (ADT)</option>
                        <option value="CHD">Child (CHD)</option>
                        <option value="INF">Infant (INF)</option>
                      </select>
                    </label>
                    <label className="text-[11px] font-medium text-slate-600">
                      First name
                      <input
                        required
                        maxLength={100}
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </label>
                    <label className="text-[11px] font-medium text-slate-600">
                      Middle name <span className="font-normal">(opt)</span>
                      <input
                        maxLength={100}
                        value={middleName}
                        onChange={(e) => setMiddleName(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </label>
                    <label className="text-[11px] font-medium text-slate-600">
                      Last name
                      <input
                        required
                        maxLength={100}
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={isSavingPassenger}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {isSavingPassenger ? 'Adding...' : 'Save Traveler'}
                  </button>
                </form>
              )}
            </section>
          )}

          {/* =================================================================
              STEP 3: CONSOLIDATOR TICKETING REQUEST (SKIPPABLE REMINDER)
          ================================================================= */}
          {activeStep === 3 && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 animate-in fade-in duration-200">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-amber-950">
                <div className="flex items-center gap-2.5">
                  <Info className="h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    <strong>Optional Reminder Step:</strong> This step is only for tracking requests sent to an external IATA consolidator. If you issue tickets directly, you can skip this step.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveStep(4)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-900 shadow-2xs transition-colors hover:bg-amber-100"
                >
                  <FastForward className="h-3.5 w-3.5" />
                  <span>Skip this step →</span>
                </button>
              </div>

              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <Send className="h-4 w-4 text-teal-700" />
                  Step 3: Consolidator Ticketing Request{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({ticketingRequests.length})
                  </span>
                </h3>
              </div>

              {ticketingRequests.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {ticketingRequests.map((request) => {
                    const nextStatuses = TICKETING_REQUEST_NEXT_STATUSES[request.status];
                    return (
                      <li
                        key={request.id}
                        className="rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-800">
                            Partner: {request.supplier_name}
                          </span>
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                              request.status === 'completed'
                                ? 'bg-emerald-100 text-emerald-800'
                                : request.status === 'failed'
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {TICKETING_REQUEST_STATUS_LABELS[request.status]}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {request.partner_request_reference &&
                            `Ref: ${request.partner_request_reference} · `}
                          {request.ticketing_deadline &&
                            `Deadline: ${new Intl.DateTimeFormat('en', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(request.ticketing_deadline))}`}
                        </p>
                        {nextStatuses.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {nextStatuses.map((nextStatus) => (
                              <button
                                key={nextStatus}
                                type="button"
                                disabled={savingRequestId === request.id}
                                onClick={() => void handleRequestStatusChange(request, nextStatus)}
                                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                              >
                                {savingRequestId === request.id
                                  ? 'Saving...'
                                  : `Mark ${TICKETING_REQUEST_STATUS_LABELS[nextStatus]}`}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {!isLocked && suppliers.length > 0 && (
                <form
                  onSubmit={handleCreateRequest}
                  className="mt-4 border-t border-slate-100 pt-4"
                >
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-xs font-semibold text-slate-700">
                      Ticketing partner
                      <select
                        required
                        value={requestSupplierId}
                        onChange={(e) => setRequestSupplierId(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs"
                      >
                        <option value="">Select partner</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.display_name} · {s.supplier_type}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs font-semibold text-slate-700">
                      Deadline <span className="font-normal text-slate-400">(opt)</span>
                      <input
                        type="datetime-local"
                        value={requestDeadline}
                        onChange={(e) => setRequestDeadline(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                      />
                    </label>
                    <label className="text-xs font-semibold text-slate-700">
                      Partner reference <span className="font-normal text-slate-400">(opt)</span>
                      <input
                        maxLength={120}
                        value={requestReference}
                        onChange={(e) => setRequestReference(e.target.value)}
                        placeholder="e.g. REQ-402"
                        className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                      />
                    </label>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={isCreatingRequest || !requestSupplierId}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {isCreatingRequest ? 'Raising...' : 'Raise Partner Request'}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          {/* =================================================================
              STEP 4: RECORD COMMERCIAL SALE & AUTO-DRAFT INVOICE
          ================================================================= */}
          {activeStep === 4 && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 animate-in fade-in duration-200">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-amber-950">
                <div className="flex items-center gap-2.5">
                  <Info className="h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    <strong>Optional Pre-Invoicing Step:</strong> Lock in your selling price now to auto-draft an invoice before the ticket is issued, or skip straight to Step 5 if you already have the 13-digit ticket number.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveStep(5)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-900 shadow-2xs transition-colors hover:bg-amber-100"
                >
                  <FastForward className="h-3.5 w-3.5" />
                  <span>Skip to E-Tickets →</span>
                </button>
              </div>

              <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <TrendingUp className="h-4 w-4 text-teal-700" />
                Step 4: Record Commercial Sale & Auto-Draft Invoice
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Numbers automatically format with commas and validate your profit margin in real time.
              </p>

              {details.passengers.length === 0 || details.segments.length === 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                  Please add at least <strong>1 flight segment (Step 1)</strong> and{' '}
                  <strong>1 traveler (Step 2)</strong> first.
                </div>
              ) : unpricedPassengers.length === 0 ? (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 text-xs text-emerald-950">
                  <span className="font-semibold">
                    All {details.passengers.length} traveler(s) have pricing or tickets recorded!
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveStep(5)}
                    className="rounded-lg bg-emerald-700 px-3.5 py-2 font-semibold text-white hover:bg-emerald-800"
                  >
                    Go to Step 5: E-Tickets →
                  </button>
                </div>
              ) : (
                <form onSubmit={handleRecordSale} className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className="block text-xs font-bold text-slate-700">
                      1. Select Traveler ({unpricedPassengers.length} pending)
                      <select
                        required
                        value={salePassengerId}
                        onChange={(e) => setSalePassengerId(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-teal-600 focus:outline-none"
                      >
                        <option value="">Select traveler</option>
                        {unpricedPassengers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.first_name} {p.middle_name ? `${p.middle_name} ` : ''}
                            {p.last_name} ({p.passenger_type})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block text-xs font-bold text-slate-700">
                      2. Ticketing Partner / Supplier
                      <select
                        required
                        value={saleSupplierId}
                        onChange={(e) => {
                          setSaleSupplierId(e.target.value);
                          const sup = suppliers.find((item) => item.id === Number(e.target.value));
                          if (sup?.settlement_currency) {
                            setSaleCostCurrency(sup.settlement_currency.trim());
                          }
                        }}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-teal-600 focus:outline-none"
                      >
                        <option value="">Select partner</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4">
                      <label className="block text-xs font-bold uppercase tracking-wider text-teal-900">
                        3. Customer Selling Price <span className="text-rose-600">*</span>
                      </label>
                      <p className="mt-0.5 text-[11px] text-teal-700">
                        Total amount billed to the customer on the invoice
                      </p>
                      <div className="mt-2.5 flex items-center gap-2">
                        <input
                          required
                          minLength={3}
                          maxLength={3}
                          value={saleSellingCurrency}
                          onChange={(e) => setSaleSellingCurrency(e.target.value.toUpperCase())}
                          className="w-20 shrink-0 rounded-xl border border-teal-300 bg-white px-3 py-2.5 text-center font-mono text-sm font-extrabold uppercase text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                        <input
                          required
                          type="text"
                          inputMode="decimal"
                          value={saleSellingPrice}
                          onChange={(e) => {
                            setSaleSellingPrice(formatNumberWithCommas(e.target.value));
                            setConfirmHighMarkupStep4(false);
                          }}
                          placeholder="e.g. 55,000"
                          className="w-full rounded-xl border border-teal-300 bg-white px-4 py-2.5 font-mono text-base font-extrabold tracking-wide text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                        />
                      </div>
                    </div>

                    <div
                      className={`rounded-2xl border p-4 transition-colors ${
                        step4IsLoss
                          ? 'border-rose-300 bg-rose-50/60'
                          : 'border-slate-200 bg-slate-50/70'
                      }`}
                    >
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-800">
                        4. Actual Supplier Ticket Cost{' '}
                        <span className="font-normal text-slate-400">(opt)</span>
                      </label>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Base fare & taxes payable to the airline/consolidator
                      </p>
                      <div className="mt-2.5 flex items-center gap-2">
                        <input
                          required={Boolean(saleCost)}
                          minLength={3}
                          maxLength={3}
                          value={saleCostCurrency}
                          onChange={(e) => setSaleCostCurrency(e.target.value.toUpperCase())}
                          className="w-20 shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-center font-mono text-sm font-extrabold uppercase text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          value={saleCost}
                          onChange={(e) => {
                            setSaleCost(formatNumberWithCommas(e.target.value));
                            setConfirmHighMarkupStep4(false);
                          }}
                          placeholder="e.g. 50,000"
                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 font-mono text-base font-extrabold tracking-wide text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                        />
                      </div>
                    </div>
                  </div>

                  {step4IsLoss && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950">
                      <div className="flex items-start gap-2.5">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                        <div>
                          <p className="font-bold text-rose-900">
                            Blocked: Supplier Cost is higher than Customer Selling Price!
                          </p>
                          <p className="mt-0.5 text-rose-800">
                            You entered a cost of{' '}
                            <strong>
                              {saleCostCurrency} {saleCost}
                            </strong>{' '}
                            against a selling price of{' '}
                            <strong>
                              {saleSellingCurrency} {saleSellingPrice}
                            </strong>{' '}
                            (a loss of {saleSellingCurrency}{' '}
                            {formatNumberWithCommas(String(Math.abs(step4Margin)))}).
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const prevSell = saleSellingPrice;
                          setSaleSellingPrice(saleCost);
                          setSaleCost(prevSell);
                        }}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-2 font-bold text-white shadow-xs hover:bg-rose-800"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        <span>Swap Selling & Cost</span>
                      </button>
                    </div>
                  )}

                  {!step4IsLoss && step4IsHighMarkup && (
                    <div className="space-y-2.5 rounded-xl border border-amber-300 bg-amber-50/90 p-4 text-xs text-amber-950">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                        <div>
                          <p className="font-bold text-amber-950">
                            High Price Alert (+{step4MarkupPct}% above actual ticket cost)
                          </p>
                          <p className="mt-0.5 text-amber-900">
                            The Customer Selling Price (
                            <strong>
                              {saleSellingCurrency} {saleSellingPrice}
                            </strong>
                            ) is significantly higher than the Supplier Ticket Cost (
                            <strong>
                              {saleCostCurrency} {saleCost}
                            </strong>
                            ). Please verify there are no extra zeros before saving.
                          </p>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 pt-1 font-bold text-amber-950">
                        <input
                          type="checkbox"
                          checked={confirmHighMarkupStep4}
                          onChange={(e) => setConfirmHighMarkupStep4(e.target.checked)}
                          className="h-4 w-4 accent-amber-700"
                        />
                        <span>
                          I confirm this higher selling price ({saleSellingCurrency}{' '}
                          {saleSellingPrice}) is intentional.
                        </span>
                      </label>
                    </div>
                  )}

                  {!step4IsLoss && (saleSellingPrice || saleCost) && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-xs">
                      <span className="font-semibold text-emerald-950">
                        Estimated Gross Profit Margin for this Traveler:
                      </span>
                      <span className="font-mono text-sm font-extrabold text-emerald-800">
                        {saleSellingCurrency} {formatNumberWithCommas(String(Math.max(0, step4Margin)))}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <button
                      type="submit"
                      disabled={
                        isSavingSale ||
                        !salePassengerId ||
                        !saleSupplierId ||
                        !saleSellingPrice ||
                        step4SellingNum <= 0 ||
                        step4IsLoss ||
                        (step4IsHighMarkup && !confirmHighMarkupStep4)
                      }
                      className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-2.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <TrendingUp className="h-4 w-4" />
                      <span>
                        {isSavingSale ? 'Saving...' : 'Save Sale & Auto-Draft Invoice'}
                      </span>
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          {/* =================================================================
              STEP 5: ISSUE VERIFIED 13-DIGIT E-TICKET
          ================================================================= */}
          {activeStep === 5 && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 animate-in fade-in duration-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                    <Ticket className="h-4 w-4 text-teal-700" />
                    Step 5: Issue Verified 13-Digit E-Tickets
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Supplier, currency, and issue date stay sticky so you can issue multiple family tickets rapidly.
                  </p>
                </div>
                <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-bold text-teal-900">
                  {issuedCount} of {details.passengers.length} Ticketed
                </span>
              </div>

              {details.tickets.length > 0 && (
                <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/50">
                  {details.tickets.map((record) => {
                    const pax = details.passengers.find(
                      (p) => p.id === record.booking_passenger_id,
                    );
                    const marginComparable =
                      record.selling_price !== null &&
                      record.selling_currency !== null &&
                      record.fare_amount !== null &&
                      record.currency != null &&
                      record.selling_currency.trim() === record.currency.trim();
                    const margin = marginComparable
                      ? Number(record.selling_price) - Number(record.fare_amount)
                      : null;

                    return (
                      <li
                        key={record.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                      >
                        <div>
                          <span className="font-semibold text-slate-900">
                            {pax ? `${pax.first_name} ${pax.last_name}` : 'Traveler'}
                          </span>
                          <span className="ml-2 font-mono font-bold text-teal-800">
                            {record.ticket_number || 'Waiting for ticket number'}
                          </span>
                          <span className="ml-2 text-slate-500">
                            ({record.supplier_name} · {record.ticket_status})
                          </span>
                        </div>
                        <div className="font-mono text-xs text-slate-700">
                          {record.selling_price !== null &&
                            `Sold: ${record.selling_currency?.trim()} ${formatNumberWithCommas(String(record.selling_price))}`}
                          {record.fare_amount !== null &&
                            ` · Cost: ${record.currency?.trim()} ${formatNumberWithCommas(String(record.fare_amount))}`}
                          {margin !== null && (
                            <span className="ml-2 rounded bg-emerald-100 px-2 py-0.5 font-bold text-emerald-900">
                              Margin: {record.selling_currency?.trim()}{' '}
                              {formatNumberWithCommas(String(margin))}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {unticketedPassengers.length === 0 && details.passengers.length > 0 ? (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 text-xs text-emerald-950">
                  <span className="font-semibold">
                    All travelers on this PNR have verified 13-digit e-tickets issued!
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveStep(6)}
                    className="rounded-lg bg-emerald-700 px-3.5 py-2 font-semibold text-white hover:bg-emerald-800"
                  >
                    Proceed to Cash & Invoices →
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={handleRecordTicket}
                  className="mt-4 space-y-4 border-t border-slate-100 pt-4"
                >
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="text-xs font-bold text-slate-700">
                      Traveler ({unticketedPassengers.length} remaining)
                      <select
                        required
                        value={ticketPassengerId}
                        onChange={(e) => setTicketPassengerId(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                      >
                        <option value="">Select traveler</option>
                        {unticketedPassengers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.first_name} {p.last_name} ({p.passenger_type})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="text-xs font-bold text-slate-700">
                      Issuing Supplier
                      <select
                        required
                        value={ticketSupplierId}
                        onChange={(e) => {
                          setTicketSupplierId(e.target.value);
                          const sup = suppliers.find((item) => item.id === Number(e.target.value));
                          if (sup?.settlement_currency) {
                            setTicketCurrency(sup.settlement_currency.trim());
                          }
                        }}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                      >
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.display_name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="text-xs font-bold text-slate-700">
                      13-Digit Ticket Number
                      <input
                        required
                        maxLength={30}
                        value={ticketNumber}
                        onChange={(e) => setTicketNumber(e.target.value.toUpperCase())}
                        placeholder="071-2491827364"
                        className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-xs font-bold text-slate-900"
                      />
                    </label>

                    <label className="text-xs font-bold text-slate-700">
                      Issue Date
                      <input
                        type="date"
                        value={issueDate}
                        onChange={(e) => setIssueDate(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-900"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-teal-200 bg-teal-50/40 p-3.5">
                      <label className="block text-xs font-bold uppercase tracking-wider text-teal-900">
                        Customer Selling Price
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          required={Boolean(sellingPrice)}
                          minLength={3}
                          maxLength={3}
                          value={sellingCurrency}
                          onChange={(e) => setSellingCurrency(e.target.value.toUpperCase())}
                          className="w-20 shrink-0 rounded-xl border border-teal-300 bg-white px-2.5 py-2 text-center font-mono text-xs font-extrabold uppercase"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          value={sellingPrice}
                          onChange={(e) => {
                            setSellingPrice(formatNumberWithCommas(e.target.value));
                            setConfirmHighMarkupStep5(false);
                          }}
                          placeholder="e.g. 70,000"
                          className="w-full rounded-xl border border-teal-300 bg-white px-3.5 py-2 font-mono text-sm font-extrabold text-slate-900"
                        />
                      </div>
                    </div>

                    <div
                      className={`rounded-2xl border p-3.5 transition-colors ${
                        step5IsLoss
                          ? 'border-rose-300 bg-rose-50/60'
                          : 'border-slate-200 bg-slate-50/70'
                      }`}
                    >
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-800">
                        Actual Supplier Ticket Cost
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          required={Boolean(fareAmount)}
                          minLength={3}
                          maxLength={3}
                          value={ticketCurrency}
                          onChange={(e) => setTicketCurrency(e.target.value.toUpperCase())}
                          className="w-20 shrink-0 rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-center font-mono text-xs font-extrabold uppercase"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          value={fareAmount}
                          onChange={(e) => setFareAmount(formatNumberWithCommas(e.target.value))}
                          placeholder="e.g. 50,000"
                          className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm font-extrabold text-slate-900"
                        />
                      </div>
                    </div>
                  </div>

                  {step5HasPriceMismatch && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950">
                      <div className="flex items-center gap-2.5">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                        <span>
                          <strong>Invoice Price Mismatch:</strong> You entered{' '}
                          <strong>
                            {sellingCurrency} {sellingPrice}
                          </strong>
                          , which is different from the{' '}
                          <strong>
                            {selectedPaxPendingSale?.selling_currency ?? sellingCurrency}{' '}
                            {formatNumberWithCommas(String(quotedSellingPrice))}
                          </strong>{' '}
                          already invoiced in Step 4.
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setSellingPrice(formatNumberWithCommas(String(quotedSellingPrice)))
                        }
                        className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 font-bold text-amber-900 hover:bg-amber-100"
                      >
                        Match Invoiced Price ({formatNumberWithCommas(String(quotedSellingPrice))})
                      </button>
                    </div>
                  )}

                  {step5IsLoss && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950">
                      <div className="flex items-start gap-2.5">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                        <div>
                          <p className="font-bold text-rose-900">
                            Blocked: Supplier Cost is higher than Customer Selling Price!
                          </p>
                          <p className="mt-0.5 text-rose-800">
                            Supplier cost ({ticketCurrency} {fareAmount}) exceeds customer selling
                            price ({sellingCurrency} {sellingPrice}).
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const prevSell = sellingPrice;
                          setSellingPrice(fareAmount);
                          setFareAmount(prevSell);
                        }}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-2 font-bold text-white shadow-xs hover:bg-rose-800"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        <span>Swap Selling & Cost</span>
                      </button>
                    </div>
                  )}

                  {!step5IsLoss && step5IsHighMarkup && (
                    <div className="space-y-2.5 rounded-xl border border-amber-300 bg-amber-50/90 p-4 text-xs text-amber-950">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                        <div>
                          <p className="font-bold text-amber-950">
                            High Price Alert (+{step5MarkupPct}% above actual ticket cost)
                          </p>
                          <p className="mt-0.5 text-amber-900">
                            Selling price ({sellingCurrency} {sellingPrice}) is more than 50%
                            higher than the actual ticket cost ({ticketCurrency} {fareAmount}).
                            Please confirm this is not a typo.
                          </p>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 pt-1 font-bold text-amber-950">
                        <input
                          type="checkbox"
                          checked={confirmHighMarkupStep5}
                          onChange={(e) => setConfirmHighMarkupStep5(e.target.checked)}
                          className="h-4 w-4 accent-amber-700"
                        />
                        <span>
                          I confirm this higher selling price ({sellingCurrency} {sellingPrice}) is
                          intentional.
                        </span>
                      </label>
                    </div>
                  )}

                  {!step5IsLoss && (sellingPrice || fareAmount) && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-2.5 text-xs">
                      <span className="font-semibold text-emerald-950">
                        Calculated Ticket Gross Margin:
                      </span>
                      <span className="font-mono text-sm font-extrabold text-emerald-800">
                        {sellingCurrency} {formatNumberWithCommas(String(Math.max(0, step5Margin)))}
                      </span>
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      required
                      type="checkbox"
                      checked={ticketVerified}
                      onChange={(e) => setTicketVerified(e.target.checked)}
                      className="h-4 w-4 accent-teal-700"
                    />
                    <span>I verified this 13-digit ticket number against the supplier e-ticket.</span>
                  </label>

                  <button
                    type="submit"
                    disabled={
                      isSavingTicket ||
                      !ticketPassengerId ||
                      !ticketSupplierId ||
                      !ticketVerified ||
                      step5IsLoss ||
                      (step5IsHighMarkup && !confirmHighMarkupStep5)
                    }
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-5 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Ticket className="h-4 w-4" />
                    {isSavingTicket ? 'Saving...' : 'Save Verified E-Ticket'}
                  </button>
                </form>
              )}
            </section>
          )}

          {/* =================================================================
              STEP 6: INVOICES, CASH COLLECTION, DOCUMENTS & AUDIT
          ================================================================= */}
          {activeStep === 6 && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
                <button
                  type="button"
                  onClick={() => setStep6SubTab('cash')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    step6SubTab === 'cash'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Wallet className="h-3.5 w-3.5" />
                  <span>Invoices & Cash ({bookingInvoices.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStep6SubTab('docs')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    step6SubTab === 'docs'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span>Documents ({documents.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStep6SubTab('audit')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    step6SubTab === 'audit'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <History className="h-3.5 w-3.5" />
                  <span>Status Audit Trail</span>
                </button>
              </div>

              {step6SubTab === 'cash' && (
                <section className="rounded-2xl border border-slate-200 bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                        <Wallet className="h-4 w-4 text-teal-700" />
                        Booking Invoices & Cash Collection
                      </h3>
                      <p className="text-xs text-slate-500">
                        Covers {details.tickets.length} of {details.passengers.length} traveler(s) on this PNR.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!paymentAmount && maxAllowedPayment > 0) {
                          setPaymentAmount(formatNumberWithCommas(String(maxAllowedPayment)));
                        }
                        setIsPaymentModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                    >
                      <CreditCard className="h-3.5 w-3.5" />
                      <span>Collect Payment</span>
                    </button>
                  </div>

                  {invoicesLoading ? (
                    <p className="mt-3 text-xs text-slate-500">Loading invoices...</p>
                  ) : bookingInvoices.length === 0 ? (
                    <p className="mt-3 text-xs text-slate-500">
                      No invoices linked yet. Recording a commercial sale in Step 4 auto-drafts an invoice.
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                      {bookingInvoices.map((inv) => (
                        <li
                          key={inv.id}
                          className="flex items-center justify-between px-3.5 py-2.5 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-slate-900">
                              {inv.invoice_number}
                            </span>
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
                              {inv.status}
                            </span>
                          </div>
                          <span className="font-mono font-bold text-slate-900">
                            {inv.currency} {formatNumberWithCommas(String(inv.grand_total))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {step6SubTab === 'docs' && (
                <section className="rounded-2xl border border-slate-200 bg-white p-5">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Paperclip className="h-4 w-4 text-teal-700" />
                    Private Booking Attachments ({documents.length})
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Store passport copies, GDS confirmations, and e-ticket PDFs (max 10 MB).
                  </p>

                  {documents.length === 0 ? (
                    <p className="mt-3 text-xs text-slate-500">
                      No files attached to this booking yet.
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                      {documents.map((doc) => (
                        <li
                          key={doc.id}
                          className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <FileText className="h-4 w-4 shrink-0 text-teal-700" />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-slate-800">
                                {doc.original_filename}
                              </p>
                              <p className="text-[10px] text-slate-500">
                                {DOCUMENT_TYPE_LABELS.find((i) => i.value === doc.document_type)
                                  ?.label ?? doc.document_type}
                                {doc.file_size_bytes !== null &&
                                  ` · ${Math.max(1, Math.round(doc.file_size_bytes / 1024))} KB`}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDownloadDocument(doc)}
                            disabled={downloadingDocumentId === doc.id}
                            className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form
                    onSubmit={handleUploadDocument}
                    className="mt-4 border-t border-slate-100 pt-4"
                  >
                    <div className="grid gap-2 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
                      <label className="text-[11px] font-medium text-slate-600">
                        Choose file
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,.webp,.txt"
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-slate-600">
                        Document type
                        <select
                          value={documentType}
                          onChange={(e) => setDocumentType(e.target.value as DocumentType)}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                        >
                          {DOCUMENT_TYPE_LABELS.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="submit"
                        disabled={isUploading}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {isUploading ? 'Uploading...' : 'Attach'}
                      </button>
                    </div>
                  </form>
                </section>
              )}

              {step6SubTab === 'audit' && (
                <section className="rounded-2xl border border-slate-200 bg-white p-5">
                  <h3 className="text-sm font-bold text-slate-900">Booking Status Audit Trail</h3>
                  {historyLoading ? (
                    <p className="mt-2 text-xs text-slate-500">Loading history...</p>
                  ) : !bookingStatusHistory || bookingStatusHistory.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">No status changes recorded yet.</p>
                  ) : (
                    <ol className="mt-3 space-y-2.5 border-l-2 border-teal-600 pl-3.5 text-xs text-slate-600">
                      {bookingStatusHistory.map((entry, i) => (
                        <li key={i}>
                          <span className="font-semibold text-slate-900">
                            {entry.from_status ?? 'Created'} → {entry.to_status}
                          </span>
                          <span className="text-slate-500">
                            {' '}
                            by {entry.changed_by ?? 'Staff'} on{' '}
                            {new Intl.DateTimeFormat('en', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(entry.changed_at))}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
            </div>
          )}

          {/* GUIDED STEP NAVIGATION FOOTER BAR */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <button
              type="button"
              disabled={activeStep === 1}
              onClick={() => setActiveStep((s) => Math.max(1, s - 1) as WizardStep)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Previous Step</span>
            </button>

            <span className="text-xs font-bold text-slate-500">
              Step {activeStep} of {WIZARD_STEPS.length}
              {WIZARD_STEPS[activeStep - 1]?.optional ? ' (Optional / Skippable)' : ''}
            </span>

            {activeStep < 6 ? (
              <button
                type="button"
                onClick={() => setActiveStep((s) => Math.min(6, s + 1) as WizardStep)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-teal-800"
              >
                <span>
                  {WIZARD_STEPS[activeStep - 1]?.optional ? 'Skip / Next: ' : 'Next: '}
                  {WIZARD_STEPS[activeStep].title.replace(/^\d+\.\s*/, '')}
                </span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveStep(1)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-4 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100"
              >
                <span>Back to Step 1</span>
              </button>
            )}
          </div>

          {/* Centered Collect Payment Modal */}
          {isPaymentModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
              <form
                onSubmit={handleCollectPayment}
                className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
              >
                <h3 className="text-base font-bold text-slate-900">Collect Customer Payment</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Customer: <strong>{booking.customer_name}</strong> ({booking.booking_code})
                </p>

                {maxAllowedPayment > 0 && (
                  <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs">
                    <span className="font-medium text-slate-600">Total Ticket / Invoice Price:</span>
                    <button
                      type="button"
                      onClick={() =>
                        setPaymentAmount(formatNumberWithCommas(String(maxAllowedPayment)))
                      }
                      className="font-mono font-bold text-teal-700 hover:underline"
                    >
                      {paymentCurrency} {formatNumberWithCommas(String(maxAllowedPayment))} (Click to fill)
                    </button>
                  </div>
                )}

                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-[1fr_6rem] gap-2">
                    <label className="block text-xs font-semibold text-slate-700">
                      Amount Received
                      <input
                        required
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 55,000"
                        value={paymentAmount}
                        onChange={(e) =>
                          setPaymentAmount(formatNumberWithCommas(e.target.value))
                        }
                        className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm font-bold text-slate-900 ${
                          isOverpayment
                            ? 'border-rose-400 bg-rose-50 text-rose-900'
                            : 'border-slate-300'
                        }`}
                      />
                    </label>
                    <label className="block text-xs font-semibold text-slate-700">
                      Currency
                      <input
                        required
                        minLength={3}
                        maxLength={3}
                        value={paymentCurrency}
                        onChange={(e) => setPaymentCurrency(e.target.value.toUpperCase())}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-center font-mono text-xs font-bold uppercase"
                      />
                    </label>
                  </div>

                  {isOverpayment && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                      <p className="font-bold">
                        Blocked: Entered amount is higher than the actual ticket/invoice price!
                      </p>
                      <p className="mt-0.5 text-rose-800">
                        Maximum allowed payment for this booking is{' '}
                        <strong>
                          {paymentCurrency} {formatNumberWithCommas(String(maxAllowedPayment))}
                        </strong>
                        .
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setPaymentAmount(formatNumberWithCommas(String(maxAllowedPayment)))
                        }
                        className="mt-2 rounded-md bg-rose-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-800"
                      >
                        Set to Exact Ticket Price ({paymentCurrency}{' '}
                        {formatNumberWithCommas(String(maxAllowedPayment))})
                      </button>
                    </div>
                  )}

                  <label className="block text-xs font-semibold text-slate-700">
                    Payment Method
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                    >
                      <option value="cash">Cash</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="card">Card</option>
                      <option value="other">Other</option>
                    </select>
                  </label>

                  <label className="block text-xs font-semibold text-slate-700">
                    Reference / Notes
                    <input
                      value={paymentNotes}
                      onChange={(e) => setPaymentNotes(e.target.value)}
                      placeholder="Bank slip or receipt reference..."
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                    />
                  </label>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsPaymentModalOpen(false)}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingPayment || isOverpayment}
                    className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSavingPayment ? 'Saving...' : 'Record Payment'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};