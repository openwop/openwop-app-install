/**
 * Screen templates for the app-builder (ADR 0305 Phase F). A CLOSED host catalog
 * of starting-point screens, built ONLY from the 35-type component catalog —
 * the parity test validates every tree via `validateComponentTree`, so a catalog
 * change can never orphan a template silently. Served on the existing GET
 * catalog route (additive `templates` field); the editor palette instantiates
 * one as a NEW screen (id-remapped client-side). Pack-shipped template packs
 * remain behind the ADR 0153 Track-2 FE-plugin RFC gate (recorded non-ship).
 */

interface TemplateNode { type: string; props?: Record<string, unknown>; children?: TemplateNode[] }
export interface ScreenTemplate {
  id: string;
  name: string;
  description: string;
  components: TemplateNode[];
}

const stack = (props: Record<string, unknown>, children: TemplateNode[]): TemplateNode => ({ type: 'stack', props, children });

export const SCREEN_TEMPLATES: readonly ScreenTemplate[] = [
  {
    id: 'dashboard', name: 'Dashboard', description: 'KPI cards, a progress block, and a recent-activity list.',
    components: [stack({ gap: 'lg' }, [
      { type: 'heading', props: { text: 'Overview', level: '1' } },
      { type: 'grid', props: { columns: 3, columnsMobile: 1, gap: 'md' }, children: [
        { type: 'card', props: { title: 'Revenue' }, children: [{ type: 'heading', props: { text: '$12,400', level: '2' } }, { type: 'badge', props: { text: '+8%', variant: 'success' } }] },
        { type: 'card', props: { title: 'Active users' }, children: [{ type: 'heading', props: { text: '1,283', level: '2' } }, { type: 'badge', props: { text: '+2%', variant: 'accent' } }] },
        { type: 'card', props: { title: 'Open tickets' }, children: [{ type: 'heading', props: { text: '17', level: '2' } }, { type: 'badge', props: { text: '-3', variant: 'warning' } }] },
      ] },
      { type: 'card', props: { title: 'Quarter goal' }, children: [{ type: 'progress', props: { value: 64, label: 'Progress to goal' } }] },
      { type: 'card', props: { title: 'Recent activity' }, children: [{ type: 'list', children: [{ type: 'text', props: { text: 'Order #1201 shipped' } }, { type: 'text', props: { text: 'New signup: Dana' } }] }] },
    ])],
  },
  {
    id: 'login', name: 'Sign in', description: 'Email + password with a primary action and a secondary link.',
    components: [stack({ gap: 'lg', padding: 'lg' }, [
      { type: 'heading', props: { text: 'Welcome back', level: '1' } },
      { type: 'text', props: { text: 'Sign in to continue.', tone: 'muted' } },
      // Inputs live in a `form`, not a bare stack — the exemplar the App
      // Architect prompt mandates (grade pass; enforced by the reference-corpus
      // exemplar tripwire). The secondary link stays outside the form.
      { type: 'form', props: {}, children: [
        { type: 'textInput', props: { label: 'Email', placeholder: 'you@example.com', kind: 'email' } },
        { type: 'textInput', props: { label: 'Password', kind: 'password' } },
        { type: 'button', props: { label: 'Sign in', variant: 'primary' } },
      ] },
      { type: 'link', props: { label: 'Forgot password?' } },
    ])],
  },
  {
    id: 'settings', name: 'Settings', description: 'Grouped toggles and inputs in accordions.',
    components: [stack({ gap: 'md' }, [
      { type: 'heading', props: { text: 'Settings', level: '1' } },
      { type: 'accordion', props: { title: 'Profile', open: true }, children: [
        { type: 'textInput', props: { label: 'Display name' } },
        { type: 'textInput', props: { label: 'Email', kind: 'email' } },
      ] },
      { type: 'accordion', props: { title: 'Notifications', open: false }, children: [
        { type: 'toggle', props: { label: 'Email notifications', on: true } },
        { type: 'toggle', props: { label: 'Push notifications', on: false } },
      ] },
      { type: 'button', props: { label: 'Save changes', variant: 'primary' } },
    ])],
  },
  {
    id: 'list-detail', name: 'List', description: 'A searchable bound list with row navigation.',
    components: [stack({ gap: 'md' }, [
      { type: 'heading', props: { text: 'Items', level: '1' } },
      { type: 'textInput', props: { placeholder: 'Search…' } },
      { type: 'list', children: [
        { type: 'card', props: { title: 'Item title' }, children: [{ type: 'text', props: { text: 'One-line summary of the item.', tone: 'muted' } }, { type: 'badge', props: { text: 'Active', variant: 'success' } }] },
      ] },
      { type: 'pagination', props: { pages: 5, active: 1 } },
    ])],
  },
  {
    id: 'profile', name: 'Profile', description: 'Avatar header with stats and actions.',
    components: [stack({ gap: 'lg' }, [
      stack({ direction: 'horizontal', gap: 'md' }, [
        { type: 'avatar', props: { name: 'Ada Lovelace', size: 'lg' } },
        stack({ gap: 'sm' }, [
          { type: 'heading', props: { text: 'Ada Lovelace', level: '2' } },
          { type: 'text', props: { text: 'Product designer', tone: 'muted' } },
          { type: 'rating', props: { value: 5, max: 5 } },
        ]),
      ]),
      { type: 'grid', props: { columns: 3, columnsMobile: 3 }, children: [
        { type: 'card', children: [{ type: 'heading', props: { text: '128', level: '3' } }, { type: 'text', props: { text: 'Projects', fontSize: 'sm', tone: 'muted' } }] },
        { type: 'card', children: [{ type: 'heading', props: { text: '4.9', level: '3' } }, { type: 'text', props: { text: 'Rating', fontSize: 'sm', tone: 'muted' } }] },
        { type: 'card', children: [{ type: 'heading', props: { text: '32', level: '3' } }, { type: 'text', props: { text: 'Reviews', fontSize: 'sm', tone: 'muted' } }] },
      ] },
      { type: 'button', props: { label: 'Edit profile', variant: 'secondary' } },
    ])],
  },
  {
    id: 'onboarding', name: 'Onboarding', description: 'Stepper-led welcome with a hero and a call to action.',
    components: [stack({ gap: 'lg', padding: 'lg' }, [
      { type: 'stepper', props: { steps: 'Welcome,Profile,Done', active: 1 } },
      { type: 'heading', props: { text: 'Let’s get you set up', level: '1' } },
      { type: 'text', props: { text: 'Three quick steps and you are in.' } },
      { type: 'alert', props: { text: 'You can change everything later in Settings.', variant: 'info' } },
      { type: 'button', props: { label: 'Continue', variant: 'primary' } },
    ])],
  },
  {
    id: 'product', name: 'Product page', description: 'Image carousel, price, rating, and buy actions.',
    components: [stack({ gap: 'md' }, [
      { type: 'breadcrumb', props: { items: 'Shop,Chairs,Aeron' } },
      { type: 'carousel', children: [
        { type: 'image', props: { src: 'https://placehold.co/480x320', alt: 'Product photo', radius: 'md' } },
        { type: 'image', props: { src: 'https://placehold.co/480x321', alt: 'Product photo 2', radius: 'md' } },
      ] },
      { type: 'heading', props: { text: 'Aeron Chair', level: '1' } },
      stack({ direction: 'horizontal', gap: 'md' }, [
        { type: 'heading', props: { text: '$1,395', level: '2' } },
        { type: 'rating', props: { value: 4, max: 5 } },
        { type: 'chip', props: { text: 'In stock', tone: 'success' } },
      ]),
      { type: 'text', props: { text: 'Ergonomic performance seating, remastered.' } },
      stack({ direction: 'horizontal', gap: 'sm' }, [
        { type: 'button', props: { label: 'Add to cart', variant: 'primary' } },
        { type: 'button', props: { label: 'Save', variant: 'secondary' } },
      ]),
    ])],
  },
  {
    id: 'feed', name: 'Feed', description: 'Social-style cards with avatars and actions.',
    components: [stack({ gap: 'md' }, [
      { type: 'heading', props: { text: 'Latest', level: '1' } },
      { type: 'card', props: { shadow: 'sm' }, children: [
        stack({ direction: 'horizontal', gap: 'sm' }, [
          { type: 'avatar', props: { name: 'Grace Hopper', size: 'sm' } },
          { type: 'text', props: { text: 'Grace Hopper · 2h', fontSize: 'sm', tone: 'muted' } },
        ]),
        { type: 'text', props: { text: 'Shipped the new compiler pipeline today!' } },
        stack({ direction: 'horizontal', gap: 'md' }, [
          { type: 'icon', props: { name: 'heart', size: 'sm' } },
          { type: 'icon', props: { name: 'send', size: 'sm' } },
        ]),
      ] },
      { type: 'fab', props: { icon: 'plus', label: 'New post' } },
    ])],
  },
  {
    id: 'contact', name: 'Contact form', description: 'Labeled fields, a select, and a submit action.',
    components: [stack({ gap: 'md' }, [
      { type: 'heading', props: { text: 'Contact us', level: '1' } },
      { type: 'form', props: {}, children: [
        { type: 'textInput', props: { label: 'Name' } },
        { type: 'textInput', props: { label: 'Email', kind: 'email' } },
        { type: 'select', props: { label: 'Topic', options: 'Support,Sales,Feedback' } },
        { type: 'radioGroup', props: { label: 'Priority', options: 'Low,Normal,High', selected: 2 } },
        { type: 'button', props: { label: 'Send message', variant: 'primary' } },
      ] },
      { type: 'snackbar', props: { text: 'We reply within one business day.', variant: 'info' } },
    ])],
  },
  {
id: 'report', name: 'Report', description: 'KPI stat cards over a data table.',
    components: [stack({ gap: 'lg' }, [
      { type: 'heading', props: { text: 'Monthly report', level: '1' } },
      { type: 'grid', props: { columns: 3, columnsMobile: 1, gap: 'md' }, children: [
        { type: 'statCard', props: { label: 'Revenue', value: '$48,900', delta: '+12%', tone: 'success' } },
        { type: 'statCard', props: { label: 'New customers', value: '312', delta: '+4%', tone: 'success' } },
        { type: 'statCard', props: { label: 'Churn', value: '2.1%', delta: '+0.3%', tone: 'warning' } },
      ] },
      { type: 'table', props: { columns: 'Product, Units, Revenue', rows: 'Starter plan, 214, $8,560\nPro plan, 96, $28,800\nEnterprise, 12, $11,540' } },
    ])],
  },
  {
    id: 'empty', name: 'Blank screen', description: 'A heading and one stack to build from.',
    components: [stack({ gap: 'md' }, [
      { type: 'heading', props: { text: 'New screen', level: '1' } },
      { type: 'text', props: { text: 'Start adding components from the palette.', tone: 'muted' } },
    ])],
  },
];
