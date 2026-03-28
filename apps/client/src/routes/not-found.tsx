import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ArrowLeftIcon, HomeIcon, RadarIcon } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_15%_20%,color-mix(in_oklch,var(--foreground),transparent_88%)_0%,transparent_45%),radial-gradient(circle_at_85%_80%,color-mix(in_oklch,var(--foreground),transparent_92%)_0%,transparent_40%),var(--background)] p-4 sm:p-8">
      <div className="pointer-events-none absolute inset-0 opacity-50 [background:linear-gradient(to_right,color-mix(in_oklch,var(--border),transparent_35%)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border),transparent_35%)_1px,transparent_1px)] bg-size-[44px_44px]" />

      <Card
        className="relative w-full max-w-2xl border-border/70 bg-card/85 shadow-2xl backdrop-blur-md"
        size="sm"
      >
        <CardHeader className="space-y-3">
          <Badge className="w-fit" variant="outline">
            <RadarIcon className="size-4" />
            Route Missing
          </Badge>
          <CardTitle className="font-heading text-4xl sm:text-5xl">
            404 - This page drifted out of range
          </CardTitle>
          <CardDescription className="max-w-xl text-sm sm:text-base">
            Helm could not find the route you requested. Jump back to the
            desktop dashboard or return to your previous page.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="rounded-2xl border border-border/70 bg-muted/45 p-4">
            <p className="font-medium text-sm">Quick recovery</p>
            <p className="mt-1 text-muted-foreground text-sm">
              Open the main workspace to continue running desktop agent tasks.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              className={cn(
                buttonVariants({ size: 'lg', variant: 'default' }),
                'w-full sm:w-auto',
              )}
              to="/"
            >
              <HomeIcon className="size-4" />
              Back to Dashboard
            </Link>
            <Button
              className="w-full sm:w-auto"
              onClick={() => window.history.back()}
              size="lg"
              variant="outline"
            >
              <ArrowLeftIcon className="size-4" />
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
