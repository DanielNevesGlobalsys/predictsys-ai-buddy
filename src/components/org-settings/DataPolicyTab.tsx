import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Shield, Database, Clock, FileDown, Fingerprint, Save, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { logOrgAuditEvent } from "@/lib/auditLog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

interface DataPolicy {
  id?: string;
  organization_id: string;
  data_retention_months: number;
  anonymize_ids: boolean;
  log_retention_months: number;
  allow_data_export: boolean;
}

const DataPolicyTab = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { currentOrganization, isOrgAdmin, isSuperAdmin } = useOrganization();

  const [policy, setPolicy] = useState<DataPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const canEdit = isOrgAdmin || isSuperAdmin;

  useEffect(() => {
    if (currentOrganization) {
      loadPolicy();
    }
  }, [currentOrganization]);

  const loadPolicy = async () => {
    if (!currentOrganization) return;

    try {
      setIsLoading(true);

      const { data, error } = await (supabase as any)
        .from("organization_data_policy")
        .select("*")
        .eq("organization_id", currentOrganization.id)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setPolicy(data);
      } else {
        // Default policy if none exists
        setPolicy({
          organization_id: currentOrganization.id,
          data_retention_months: 12,
          anonymize_ids: false,
          log_retention_months: 12,
          allow_data_export: true,
        });
      }
    } catch (error) {
      console.error("Error loading data policy:", error);
      toast({
        title: t("common.error"),
        description: t("lgpd.loadError"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!policy || !currentOrganization || !canEdit) return;

    try {
      setIsSaving(true);

      const policyData = {
        organization_id: currentOrganization.id,
        data_retention_months: policy.data_retention_months,
        anonymize_ids: policy.anonymize_ids,
        log_retention_months: policy.log_retention_months,
        allow_data_export: policy.allow_data_export,
      };

      let result;
      if (policy.id) {
        result = await (supabase as any)
          .from("organization_data_policy")
          .update(policyData)
          .eq("id", policy.id)
          .select()
          .single();
      } else {
        result = await (supabase as any)
          .from("organization_data_policy")
          .insert(policyData)
          .select()
          .single();
      }

      if (result.error) throw result.error;

      setPolicy(result.data);
      setHasChanges(false);

      // Log audit event
      await logOrgAuditEvent(
        currentOrganization.id,
        "retention_policy_updated",
        "config",
        "data_policy",
        {
          data_retention_months: policy.data_retention_months,
          log_retention_months: policy.log_retention_months,
          anonymize_ids: policy.anonymize_ids,
          allow_data_export: policy.allow_data_export,
        }
      );

      toast({
        title: t("common.success"),
        description: t("lgpd.saveSuccess"),
      });
    } catch (error) {
      console.error("Error saving data policy:", error);
      toast({
        title: t("common.error"),
        description: t("lgpd.saveError"),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updatePolicy = (updates: Partial<DataPolicy>) => {
    if (!policy) return;
    setPolicy({ ...policy, ...updates });
    setHasChanges(true);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <Alert>
        <Shield className="h-4 w-4" />
        <AlertDescription>
          {t("lgpd.infoText")}
        </AlertDescription>
      </Alert>

      {/* Data Retention */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            {t("lgpd.dataRetention")}
          </CardTitle>
          <CardDescription>{t("lgpd.dataRetentionDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="data_retention">{t("lgpd.dataRetentionMonths")}</Label>
              <Input
                id="data_retention"
                type="number"
                min={1}
                max={120}
                value={policy?.data_retention_months || 12}
                onChange={(e) => updatePolicy({ data_retention_months: parseInt(e.target.value) || 12 })}
                disabled={!canEdit}
              />
              <p className="text-xs text-muted-foreground">
                {t("lgpd.dataRetentionHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="log_retention">{t("lgpd.logRetentionMonths")}</Label>
              <Input
                id="log_retention"
                type="number"
                min={1}
                max={120}
                value={policy?.log_retention_months || 12}
                onChange={(e) => updatePolicy({ log_retention_months: parseInt(e.target.value) || 12 })}
                disabled={!canEdit}
              />
              <p className="text-xs text-muted-foreground">
                {t("lgpd.logRetentionHelp")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Privacy Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="w-5 h-5" />
            {t("lgpd.privacySettings")}
          </CardTitle>
          <CardDescription>{t("lgpd.privacySettingsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="anonymize_ids" className="font-medium">
                {t("lgpd.anonymizeIds")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t("lgpd.anonymizeIdsDesc")}
              </p>
            </div>
            <Switch
              id="anonymize_ids"
              checked={policy?.anonymize_ids || false}
              onCheckedChange={(checked) => updatePolicy({ anonymize_ids: checked })}
              disabled={!canEdit}
            />
          </div>

          {policy?.anonymize_ids && (
            <Alert variant="default" className="border-amber-500/50 bg-amber-500/10">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <AlertDescription className="text-amber-700 dark:text-amber-300">
                {t("lgpd.anonymizeWarning")}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Export Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileDown className="w-5 h-5" />
            {t("lgpd.exportSettings")}
          </CardTitle>
          <CardDescription>{t("lgpd.exportSettingsDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="allow_export" className="font-medium">
                {t("lgpd.allowExport")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t("lgpd.allowExportDesc")}
              </p>
            </div>
            <Switch
              id="allow_export"
              checked={policy?.allow_data_export ?? true}
              onCheckedChange={(checked) => updatePolicy({ allow_data_export: checked })}
              disabled={!canEdit}
            />
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      {canEdit && (
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="gap-2"
          >
            <Save className="w-4 h-4" />
            {isSaving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      )}

      {/* Trust Statement */}
      <Card className="bg-muted/50 border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Database className="w-5 h-5 text-primary mt-0.5" />
            <div>
              <p className="font-medium text-sm">{t("lgpd.trustTitle")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("lgpd.trustText")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default DataPolicyTab;
