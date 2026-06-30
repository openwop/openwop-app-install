/**
 * Card host — looks up the registration for a given cardType, wraps
 * the component in an error boundary, and renders it. Adopters use
 * this component as the single mounting point for chat-inline cards.
 */

import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getCard } from './CardRegistry.js';
import type { CardProps } from './types.js';
import i18n from '../../i18n/index.js';

interface ErrorBoundaryProps {
  cardType: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class CardErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`[CardHost] card "${this.props.cardType}" threw:`, error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="alert error cardhost-alert">
          {i18n.t('chat:cardCrashedPrefix')}<code>{this.props.cardType}</code>{i18n.t('chat:cardCrashedSuffix')} {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export function CardHost(props: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const registration = getCard(props.cardType);
  if (!registration) {
    return (
      <div className="alert info cardhost-alert">
        {t('noCardRegisteredPrefix')}<code>{props.cardType}</code>{t('noCardRegisteredSuffix')}
        <code>registerCard()</code>.
      </div>
    );
  }
  const { Component: CardComponent } = registration;
  return (
    <CardErrorBoundary cardType={props.cardType}>
      <CardComponent {...props} />
    </CardErrorBoundary>
  );
}
