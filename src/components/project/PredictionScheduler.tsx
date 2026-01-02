import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Calendar,
  Clock,
  Mail,
  Play,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Loader2,
  CalendarClock,
  Cpu,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface PredictionSchedulerProps {
  projectId: string;
  productionModelName?: string;
  onScheduleChange?: () => void;
}

interface Schedule {
  id: string;
  project_id: string;
  model_id: string | null;
  frequency: string;
  start_at: string;
  next_run_at: string;
  enabled: boolean;
  send_email_to: string;
  run_predictions: boolean;
  run_retraining: boolean;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_message: string | null;
}

type FrequencyType = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "yearly" | "specific_date";

const PredictionScheduler = ({ projectId, productionModelName, onScheduleChange }: PredictionSchedulerProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [userEmail, setUserEmail] = useState("");
  
  // Form state
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<FrequencyType>("monthly");
  const [timeOfDay, setTimeOfDay] = useState("08:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [specificDate, setSpecificDate] = useState("");
  const [email, setEmail] = useState("");
  const [runPredictions, setRunPredictions] = useState(true);
  const [runRetraining, setRunRetraining] = useState(false);

  const frequencyOptions = [
    { value: "daily", labelKey: "deploy.scheduler.frequencies.daily" },
    { value: "weekly", labelKey: "deploy.scheduler.frequencies.weekly" },
    { value: "biweekly", labelKey: "deploy.scheduler.frequencies.biweekly" },
    { value: "monthly", labelKey: "deploy.scheduler.frequencies.monthly" },
    { value: "quarterly", labelKey: "deploy.scheduler.frequencies.quarterly" },
    { value: "semiannual", labelKey: "deploy.scheduler.frequencies.semiannual" },
    { value: "yearly", labelKey: "deploy.scheduler.frequencies.yearly" },
    { value: "specific_date", labelKey: "deploy.scheduler.frequencies.specificDate" },
  ];

  const weekDays = [
    { value: 0, labelKey: "deploy.scheduler.weekDays.sunday" },
    { value: 1, labelKey: "deploy.scheduler.weekDays.monday" },
    { value: 2, labelKey: "deploy.scheduler.weekDays.tuesday" },
    { value: 3, labelKey: "deploy.scheduler.weekDays.wednesday" },
    { value: 4, labelKey: "deploy.scheduler.weekDays.thursday" },
    { value: 5, labelKey: "deploy.scheduler.weekDays.friday" },
    { value: 6, labelKey: "deploy.scheduler.weekDays.saturday" },
  ];

  useEffect(() => {
    loadSchedule();
    loadUserEmail();
  }, [projectId]);

  const loadUserEmail = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email) {
      setUserEmail(user.email);
      if (!email) {
        setEmail(user.email);
      }
    }
  };

  const loadSchedule = async () => {
    setLoading(true);
    
    const { data, error } = await supabase
      .from("project_prediction_schedules")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle();

    if (data) {
      setSchedule(data);
      setEnabled(data.enabled);
      setFrequency(data.frequency as FrequencyType);
      setTimeOfDay(data.time_of_day?.slice(0, 5) || "08:00");
      setDayOfWeek(data.day_of_week ?? 1);
      setDayOfMonth(data.day_of_month ?? 1);
      setEmail(data.send_email_to);
      setRunPredictions(data.run_predictions);
      setRunRetraining(data.run_retraining);
      if (data.frequency === "specific_date" && data.next_run_at) {
        setSpecificDate(data.next_run_at.slice(0, 16));
      }
    } else {
      // Set defaults with user email
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) {
        setEmail(user.email);
      }
    }
    
    setLoading(false);
  };

  const calculateNextRun = (): Date => {
    const now = new Date();
    const [hours, minutes] = timeOfDay.split(":").map(Number);
    
    if (frequency === "specific_date" && specificDate) {
      return new Date(specificDate);
    }
    
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    
    switch (frequency) {
      case "weekly":
        while (next.getDay() !== dayOfWeek) {
          next.setDate(next.getDate() + 1);
        }
        break;
      case "biweekly":
        while (next.getDay() !== dayOfWeek) {
          next.setDate(next.getDate() + 1);
        }
        break;
      case "monthly":
      case "quarterly":
      case "semiannual":
      case "yearly":
        next.setDate(dayOfMonth);
        if (next <= now) {
          next.setMonth(next.getMonth() + 1);
        }
        break;
    }
    
    return next;
  };

  const saveSchedule = async () => {
    if (!email) {
      toast({
        title: t("deploy.scheduler.errors.emailRequired"),
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    
    const nextRunAt = calculateNextRun();
    
    const scheduleData = {
      project_id: projectId,
      frequency,
      enabled,
      send_email_to: email,
      run_predictions: runPredictions,
      run_retraining: runRetraining,
      day_of_week: ["weekly", "biweekly"].includes(frequency) ? dayOfWeek : null,
      day_of_month: ["monthly", "quarterly", "semiannual", "yearly"].includes(frequency) ? dayOfMonth : null,
      time_of_day: timeOfDay + ":00",
      next_run_at: nextRunAt.toISOString(),
      start_at: new Date().toISOString(),
    };

    let error;
    
    if (schedule) {
      const result = await supabase
        .from("project_prediction_schedules")
        .update(scheduleData)
        .eq("id", schedule.id);
      error = result.error;
    } else {
      const result = await supabase
        .from("project_prediction_schedules")
        .insert(scheduleData);
      error = result.error;
    }

    if (error) {
      console.error("Error saving schedule:", error);
      toast({
        title: t("deploy.scheduler.errors.saveFailed"),
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: t("deploy.scheduler.saved"),
      });
      loadSchedule();
      onScheduleChange?.();
    }
    
    setSaving(false);
  };

  const formatNextRun = (date: string | null): string => {
    if (!date) return "-";
    return new Date(date).toLocaleString();
  };

  const getStatusIcon = (status: string | null) => {
    switch (status) {
      case "success":
        return <CheckCircle className="w-4 h-4 text-accent" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      case "running":
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  if (loading) {
    return (
      <Card className="bg-gradient-card shadow-card p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <CalendarClock className="w-6 h-6 text-primary" />
          <div>
            <h3 className="font-semibold text-lg">{t("deploy.scheduler.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("deploy.scheduler.description")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="schedule-enabled" className="text-sm">
            {t("deploy.scheduler.enableToggle")}
          </Label>
          <Switch
            id="schedule-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </div>

      <div className="space-y-6">
        {/* Frequency selection */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("deploy.scheduler.frequency")}</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as FrequencyType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {frequencyOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Time of day */}
          {frequency !== "specific_date" && (
            <div className="space-y-2">
              <Label>{t("deploy.scheduler.timeOfDay")}</Label>
              <Input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Day of week for weekly/biweekly */}
        {["weekly", "biweekly"].includes(frequency) && (
          <div className="space-y-2">
            <Label>{t("deploy.scheduler.dayOfWeek")}</Label>
            <Select value={String(dayOfWeek)} onValueChange={(v) => setDayOfWeek(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {weekDays.map((day) => (
                  <SelectItem key={day.value} value={String(day.value)}>
                    {t(day.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Day of month for monthly+ */}
        {["monthly", "quarterly", "semiannual", "yearly"].includes(frequency) && (
          <div className="space-y-2">
            <Label>{t("deploy.scheduler.dayOfMonth")}</Label>
            <Select value={String(dayOfMonth)} onValueChange={(v) => setDayOfMonth(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                  <SelectItem key={day} value={String(day)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Specific date */}
        {frequency === "specific_date" && (
          <div className="space-y-2">
            <Label>{t("deploy.scheduler.specificDateTime")}</Label>
            <Input
              type="datetime-local"
              value={specificDate}
              onChange={(e) => setSpecificDate(e.target.value)}
              min={new Date().toISOString().slice(0, 16)}
            />
          </div>
        )}

        {/* Email notification */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Mail className="w-4 h-4" />
            {t("deploy.scheduler.notificationEmail")}
          </Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={userEmail}
          />
        </div>

        {/* Actions checkboxes */}
        <div className="space-y-4 p-4 bg-muted/20 rounded-lg">
          <Label className="text-sm font-medium">
            {t("deploy.scheduler.scheduledActions")}
          </Label>
          
          <div className="flex items-center gap-3">
            <Checkbox
              id="run-predictions"
              checked={runPredictions}
              onCheckedChange={(c) => setRunPredictions(c === true)}
            />
            <Label htmlFor="run-predictions" className="text-sm cursor-pointer flex items-center gap-2">
              <Play className="w-4 h-4" />
              {t("deploy.scheduler.actions.runPredictions")}
            </Label>
          </div>

          <TooltipProvider>
            <div className="flex items-center gap-3">
              <Checkbox
                id="run-retraining"
                checked={runRetraining}
                onCheckedChange={(c) => setRunRetraining(c === true)}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label htmlFor="run-retraining" className="text-sm cursor-pointer flex items-center gap-2">
                    <RefreshCw className="w-4 h-4" />
                    {t("deploy.scheduler.actions.runRetraining")}
                    <span className="text-xs px-2 py-0.5 bg-secondary/20 rounded-full">
                      {t("deploy.scheduler.actions.advanced")}
                    </span>
                  </Label>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">{t("deploy.scheduler.actions.retrainingTooltip")}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {/* Summary */}
        <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("deploy.scheduler.summary.nextRun")}
            </span>
            <span className="font-medium flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              {enabled ? formatNextRun(calculateNextRun().toISOString()) : "-"}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("deploy.scheduler.summary.productionModel")}
            </span>
            <span className="font-medium flex items-center gap-2">
              <Cpu className="w-4 h-4" />
              {productionModelName || t("deploy.scheduler.summary.noModel")}
            </span>
          </div>

          {schedule?.last_run_at && (
            <div className="flex items-center justify-between pt-2 border-t border-border/50">
              <span className="text-sm text-muted-foreground">
                {t("deploy.scheduler.summary.lastRun")}
              </span>
              <span className="font-medium flex items-center gap-2">
                {getStatusIcon(schedule.last_run_status)}
                {formatNextRun(schedule.last_run_at)}
              </span>
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="flex justify-end">
          <Button onClick={saveSchedule} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("common.loading")}
              </>
            ) : (
              t("common.save")
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default PredictionScheduler;
