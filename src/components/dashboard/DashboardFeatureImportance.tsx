import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Sparkles, Info } from "lucide-react";

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface DashboardFeatureImportanceProps {
  featureImportances: FeatureImportance[];
}

const DashboardFeatureImportance = ({ featureImportances }: DashboardFeatureImportanceProps) => {
  const { t } = useTranslation();

  if (!featureImportances || featureImportances.length === 0) {
    return null;
  }

  const chartData = featureImportances.slice(0, 10).map(f => ({
    name: f.feature_name.length > 15 ? f.feature_name.substring(0, 15) + "..." : f.feature_name,
    fullName: f.feature_name,
    value: f.importance_value,
  }));

  const maxImportance = Math.max(...featureImportances.map(f => f.importance_value));

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("modelDashboard.features.title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {t("modelDashboard.features.description")}
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis type="number" domain={[0, 1]} className="text-xs" />
              <YAxis dataKey="name" type="category" width={100} className="text-xs" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => [value.toFixed(4), t("modelDashboard.features.importance")]}
                labelFormatter={(label) => chartData.find(d => d.name === label)?.fullName || label}
              />
              <Bar
                dataKey="value"
                fill="hsl(var(--primary))"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("modelDashboard.features.variable")}</TableHead>
                <TableHead className="text-right">{t("modelDashboard.features.importance")}</TableHead>
                <TableHead className="text-right">{t("modelDashboard.features.relative")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {featureImportances.slice(0, 10).map((feature, index) => (
                <TableRow key={feature.feature_name}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{index + 1}</span>
                      {feature.feature_name}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {feature.importance_value.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full"
                          style={{ width: `${(feature.importance_value / maxImportance) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground w-10 text-right">
                        {((feature.importance_value / maxImportance) * 100).toFixed(0)}%
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Interpretation text */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg flex gap-3">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <p className="text-sm text-muted-foreground">
          {t("modelDashboard.features.interpretation")}
        </p>
      </div>
    </Card>
  );
};

export default DashboardFeatureImportance;
