import { useState, useMemo } from "react";
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
  Cell,
} from "recharts";
import { Layers, Info } from "lucide-react";

interface DashboardSegmentationProps {
  problemType: string;
  productionModelId: string;
}

const DashboardSegmentation = ({ problemType, productionModelId }: DashboardSegmentationProps) => {
  const { t } = useTranslation();

  // Simulated segmentation data
  const classificationSegments = useMemo(() => [
    { range: "0-20%", count: 4500, percent: 45, avgTarget: 0.02 },
    { range: "20-40%", count: 2000, percent: 20, avgTarget: 0.08 },
    { range: "40-60%", count: 1500, percent: 15, avgTarget: 0.25 },
    { range: "60-80%", count: 1200, percent: 12, avgTarget: 0.55 },
    { range: "80-100%", count: 800, percent: 8, avgTarget: 0.85 },
  ], []);

  const regressionSegments = useMemo(() => [
    { range: "Q1", count: 2500, percent: 25, avgTarget: 150 },
    { range: "Q2", count: 2500, percent: 25, avgTarget: 450 },
    { range: "Q3", count: 2500, percent: 25, avgTarget: 850 },
    { range: "Q4", count: 2500, percent: 25, avgTarget: 1500 },
  ], []);

  const segments = problemType === "classification" ? classificationSegments : regressionSegments;

  const colors = [
    "hsl(var(--accent))",
    "hsl(var(--primary) / 0.7)",
    "hsl(var(--secondary))",
    "hsl(var(--primary))",
    "hsl(var(--destructive))",
  ];

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Layers className="w-5 h-5 text-accent" />
        <h3 className="font-semibold">{t("modelDashboard.segmentation.title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {problemType === "classification"
          ? t("modelDashboard.segmentation.descClassification")
          : t("modelDashboard.segmentation.descRegression")}
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={segments}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="range" className="text-xs" />
              <YAxis className="text-xs" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => [
                  value.toLocaleString(),
                  t("modelDashboard.segmentation.records"),
                ]}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {segments.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {problemType === "classification"
                    ? t("modelDashboard.segmentation.probabilityRange")
                    : t("modelDashboard.segmentation.valueRange")}
                </TableHead>
                <TableHead className="text-right">{t("modelDashboard.segmentation.records")}</TableHead>
                <TableHead className="text-right">{t("modelDashboard.segmentation.percentBase")}</TableHead>
                <TableHead className="text-right">
                  {problemType === "classification"
                    ? t("modelDashboard.segmentation.eventRate")
                    : t("modelDashboard.segmentation.avgValue")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((segment, index) => (
                <TableRow key={segment.range}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: colors[index % colors.length] }}
                      />
                      <span className="font-medium">{segment.range}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {segment.count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">{segment.percent}%</TableCell>
                  <TableCell className="text-right font-mono">
                    {problemType === "classification"
                      ? `${(segment.avgTarget * 100).toFixed(1)}%`
                      : segment.avgTarget.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Interpretation */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg flex gap-3">
        <Info className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
        <p className="text-sm text-muted-foreground">
          {problemType === "classification"
            ? t("modelDashboard.segmentation.interpretClassification")
            : t("modelDashboard.segmentation.interpretRegression")}
        </p>
      </div>
    </Card>
  );
};

export default DashboardSegmentation;
