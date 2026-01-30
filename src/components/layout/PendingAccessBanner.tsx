import { useTranslation } from 'react-i18next';
import { Lock, Clock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface PendingAccessBannerProps {
  organizationName?: string;
}

const PendingAccessBanner = ({ organizationName }: PendingAccessBannerProps) => {
  const { t } = useTranslation();

  return (
    <Alert variant="default" className="border-amber-500 bg-amber-50 dark:bg-amber-950/20 mb-6">
      <Lock className="h-5 w-5 text-amber-600" />
      <AlertTitle className="text-amber-800 dark:text-amber-400 flex items-center gap-2">
        <Clock className="h-4 w-4" />
        {t('access.pendingTitle')}
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300 mt-2">
        <p>{t('access.pendingDescription')}</p>
        {organizationName && (
          <p className="mt-1 font-medium">
            {t('access.pendingOrg', { org: organizationName })}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
};

export default PendingAccessBanner;
