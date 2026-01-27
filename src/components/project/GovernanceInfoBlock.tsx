import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Shield, Check, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface DataPolicy {
  data_retention_months: number;
  anonymize_ids: boolean;
}

const GovernanceInfoBlock = () => {
  const { t } = useTranslation();
  const { currentOrganization } = useOrganization();
  const [policy, setPolicy] = useState<DataPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (currentOrganization) {
      loadPolicy();
    }
  }, [currentOrganization]);

  const loadPolicy = async () => {
    if (!currentOrganization) return;

    try {
      const { data } = await (supabase as any)
        .from("organization_data_policy")
        .select("data_retention_months, anonymize_ids")
        .eq("organization_id", currentOrganization.id)
        .maybeSingle();

      setPolicy(data || {
        data_retention_months: 12,
        anonymize_ids: false,
      });
    } catch (error) {
      console.error("Error loading policy:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className="w-4 h-4 text-primary" />
          {t("lgpd.governanceTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-green-500" />
            <span>
              {t("lgpd.isolatedData", { org: currentOrganization?.name })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-green-500" />
            <span>
              {t("lgpd.retentionConfig", { months: policy?.data_retention_months || 12 })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-green-500" />
            <span>
              {t("lgpd.anonymization", { 
                status: policy?.anonymize_ids ? t("lgpd.enabled") : t("lgpd.disabled") 
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-green-500" />
            <span>{t("lgpd.auditActive")}</span>
          </div>
        </div>
        
        <Link 
          to="/org/settings" 
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
        >
          {t("lgpd.viewPolicy")}
          <ExternalLink className="w-3 h-3" />
        </Link>
      </CardContent>
    </Card>
  );
};

export default GovernanceInfoBlock;
